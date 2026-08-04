/* compress.js - 图片处理核心:解码 → 缩放 → 重编码 → Blob
   全部在浏览器本地完成,图片不上传任何服务器。 */

/**
 * 检查当前浏览器是否支持 WebP 编码。
 * @returns {boolean}
 */
function supportsWebP() {
  try {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    return c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
  } catch (e) {
    return false;
  }
}

/**
 * 格式化字节数为人类可读字符串,如 "1.2 MB"。
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let v = bytes;
  let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[u];
}

/** 由原文件名生成新扩展名的文件名。 */
function changeExt(name, ext) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base + '.' + ext;
}

/** 由 MIME 得到扩展名。 */
function mimeToExt(mime) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/gif') return 'gif';
  return 'jpg';
}

/**
 * 把 File/Blob 解码为 HTMLImageElement。
 * @param {Blob} blob
 * @returns {Promise<HTMLImageElement>}
 */
function decodeImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败,文件可能已损坏')); };
    img.src = url;
  });
}

/**
 * canvas.toBlob 的 Promise 封装。
 * @param {HTMLCanvasElement} canvas
 * @param {string} mime
 * @param {number} quality 0~1
 * @returns {Promise<Blob>}
 */
function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('图片编码失败'));
    }, mime, quality);
  });
}

/** 解码后像素总数过大时给出警告阈值(约 40MP,超出容易触发内存压力)。 */
const MAX_PIXELS = 40000000;

/** 把图片按模式绘制到 canvas(支持普通缩放和 preset 居中裁剪)。 */
function drawToCanvas(canvas, img, outW, outH, presetMode) {
  const ctx = canvas.getContext('2d');
  if (presetMode) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const scale = Math.max(outW / iw, outH / ih);
    const sw = outW / scale, sh = outH / scale;
    const sx = (iw - sw) / 2, sy = (ih - sh) / 2;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
  } else {
    ctx.drawImage(img, 0, 0, outW, outH);
  }
}

/**
 * 自动把图片压到目标大小以内:对每种尺寸/格式用"二分查找"最小尝试次数逼近目标。
 * 典型 7~15 次编码,远少于原来最多 140 次。
 */
async function compressToTarget(img, baseW, baseH, mime, presetMode, targetBytes) {
  const canvas = document.createElement('canvas');
  // 目标大小场景:优先 jpg(相册/系统不转码,保存后体积准确);
  // webp 体积小但 iOS 相册会转成 jpg 导致膨胀,仅作兜底
  const fmts = [];
  if (mime !== 'image/jpeg') fmts.push('image/jpeg');
  if (mime !== 'image/webp' && supportsWebP()) fmts.push('image/webp');
  if (!fmts.includes(mime)) fmts.push(mime);
  const scaleSteps = presetMode ? [1] : [1, 0.8, 0.6, 0.45, 0.3, 0.2];

  // 对给定尺寸/格式编码一次
  async function encode(cw, ch, m, q) {
    canvas.width = cw;
    canvas.height = ch;
    drawToCanvas(canvas, img, cw, ch, presetMode);
    return canvasToBlob(canvas, m, q !== undefined ? q / 100 : undefined);
  }

  // 二分质量:在 [5,100] 找"最大且 <= 目标"的质量
  async function binaryQuality(cw, ch, m) {
    let lo = 5, hi = 100, best = null, bestSize = Infinity;
    while (lo <= hi) {
      const mid = Math.round((lo + hi) / 2);
      const blob = await encode(cw, ch, m, mid);
      if (blob.size <= targetBytes) {
        if (blob.size < bestSize) { bestSize = blob.size; best = { blob, quality: mid }; }
        lo = mid + 1;      // 还能更大质量
      } else {
        hi = mid - 1;      // 质量太高,降低
      }
    }
    if (!best) {           // 5% 仍超目标,取最低质量兜底
      const blob = await encode(cw, ch, m, 5);
      best = { blob, quality: 5 };
    }
    return best;
  }

  let best = null;   // 所有尝试中最小的(兜底)
  let found = null;  // 第一个达标的结果

  outer:
  for (const s of scaleSteps) {
    const cw = Math.max(1, Math.round(baseW * s));
    const ch = Math.max(1, Math.round(baseH * s));
    for (const m of fmts) {
      const r = await binaryQuality(cw, ch, m);
      if (!best || r.blob.size < best.blob.size) {
        best = { blob: r.blob, mime: m, quality: r.quality, w: cw, h: ch };
      }
      if (r.blob.size <= targetBytes) {
        found = { blob: r.blob, mime: m, quality: r.quality, w: cw, h: ch };
        break outer;
      }
    }
  }

  const r = found || best;
  // 校验实际输出格式(某些浏览器 webp 编码会静默降级)
  if (r.blob.type && r.blob.type !== r.mime) {
    r.mime = r.blob.type;
  }
  const strategy = [];
  if (r.w !== baseW || r.h !== baseH) strategy.push('尺寸 ' + r.w + '×' + r.h);
  if (r.mime !== mime) strategy.push('格式 ' + mimeToExt(r.mime));
  if (r.quality !== undefined) strategy.push('质量 ' + r.quality + '%');
  const targetKb = Math.round(targetBytes / 1024);
  const warning = '目标 ≤' + targetKb + 'KB,已自动' +
    (found ? '压缩至 ' + formatSize(r.blob.size) : '压至最小 ' + formatSize(r.blob.size) + ',仍超目标') +
    (strategy.length ? '(' + strategy.join('、') + ')' : '');
  return { blob: r.blob, mime: r.mime, w: r.w, h: r.h, warning };
}

/**
 * 压缩/缩放/转格式一张图片。
 * @param {File} file 原始文件
 * @param {object} opts
 * @param {number} opts.quality 压缩质量 1~100
 * @param {string} opts.scaleMode 'none' | 'width' | 'ratio' | 'preset'
 * @param {number} opts.targetWidth 按宽度缩放时的目标宽度
 * @param {number} opts.targetRatio 按比例缩放时的百分比(1~100)
 * @param {number} opts.presetW preset 模式的目标宽度
 * @param {number} opts.presetH preset 模式的目标高度
 * @param {string} opts.outputFormat 'original' | 'jpeg' | 'webp' | 'png'
 * @param {number} opts.targetKB 目标大小(KB);>0 时自动压到该大小以内
 * @returns {Promise<{blob: Blob, fileName: string, width: number, height: number,
 *          originalSize: number, newSize: number, warning?: string, targetKB?: number}>}
 */
async function compressImage(file, opts) {
  const originalSize = file.size;
  const img = await decodeImage(file);

  // 超大图提醒
  const pixels = img.naturalWidth * img.naturalHeight;
  let warning = '';
  if (pixels > MAX_PIXELS) {
    warning = '图片很大,可能压缩较慢或内存不足,建议先改小尺寸';
  }

  // 计算目标尺寸(等比缩放;preset 模式为精确尺寸)
  let outW = img.naturalWidth;
  let outH = img.naturalHeight;
  let presetMode = false;
  if (opts.scaleMode === 'preset' && opts.presetW > 0 && opts.presetH > 0) {
    outW = opts.presetW;
    outH = opts.presetH;
    presetMode = true;
  } else if (opts.scaleMode === 'width' && opts.targetWidth > 0 && opts.targetWidth < outW) {
    outH = Math.round(outH * (opts.targetWidth / outW));
    outW = opts.targetWidth;
  } else if (opts.scaleMode === 'ratio' && opts.targetRatio > 0 && opts.targetRatio < 100) {
    const r = opts.targetRatio / 100;
    outW = Math.max(1, Math.round(outW * r));
    outH = Math.max(1, Math.round(outH * r));
  }

  // 确定输出 MIME
  const isGif = file.type === 'image/gif';
  let mime;
  switch (opts.outputFormat) {
    case 'jpeg': mime = 'image/jpeg'; break;
    case 'webp': mime = 'image/webp'; break;
    case 'png':  mime = 'image/png';  break;
    case 'auto': // 自动:PNG/GIF 转 webp(或 jpg)以便压缩,jpg/webp 保持
      if (file.type === 'image/png') {
        mime = supportsWebP() ? 'image/webp' : 'image/jpeg';
        warning = (warning ? warning + ';' : '') + 'PNG 是无损格式压不动,已自动转为 ' + mimeToExt(mime) + ' 以便压缩';
      } else if (isGif) {
        mime = 'image/jpeg';
        warning = (warning ? warning + ';' : '') + 'GIF 动态图不支持,已按静态帧转为 jpg';
      } else if (file.type === 'image/jpeg' || file.type === 'image/webp') {
        mime = file.type;
      } else {
        mime = 'image/jpeg';
      }
      break;
    default: // original
      if (isGif) {
        mime = 'image/jpeg';
        warning = (warning ? warning + ';' : '') + 'GIF 动态图不支持,已按静态帧转为 jpg';
      } else if (file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp') {
        mime = file.type;
      } else {
        mime = 'image/jpeg';
      }
  }

  // 目标格式不支持时降级
  if (mime === 'image/webp' && !supportsWebP()) {
    mime = 'image/jpeg';
    warning = (warning ? warning + ';' : '') + '当前浏览器不支持 webp,已降级为 jpg';
  }

  // 目标大小模式:按目标值的 70% 压,预留相册/系统转码膨胀余量
  if (opts.targetKB > 0 && originalSize > opts.targetKB * 1024 * 0.7) {
    const targetBytes = Math.round(opts.targetKB * 1024 * 0.7);
    const r = await compressToTarget(img, outW, outH, mime, presetMode, targetBytes);
    warning = (warning ? warning + ';' : '') + r.warning;
    warning += ';已按目标值的 70% 压缩,预留相册转码空间';
    if (presetMode) {
      warning += ';已按规格 ' + outW + '×' + outH + ' 居中裁剪';
    }
    return {
      blob: r.blob,
      fileName: changeExt(file.name, mimeToExt(r.mime)),
      width: r.w,
      height: r.h,
      originalSize,
      newSize: r.blob.size,
      warning,
      targetKB: opts.targetKB
    };
  }

  // Canvas 重编码(png 无质量参数)
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布,请更换浏览器');

  if (presetMode) {
    // 等比放大填满目标框,居中裁剪(证件照标准做法)
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const scale = Math.max(outW / iw, outH / ih);
    const sw = outW / scale, sh = outH / scale;      // 源图裁剪区域(与目标同比例)
    const sx = (iw - sw) / 2, sy = (ih - sh) / 2;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
    warning = (warning ? warning + ';' : '') + '已按规格 ' + outW + '×' + outH + ' 居中裁剪';
  } else {
    ctx.drawImage(img, 0, 0, outW, outH);
  }

  const quality = mime === 'image/png' ? undefined : (opts.quality / 100);
  let blob;
  try {
    blob = await canvasToBlob(canvas, mime, quality);
  } catch (e) {
    throw new Error('处理失败:' + e.message + (pixels > MAX_PIXELS ? '(图片可能过大)' : ''));
  }

  // 校验实际输出格式:某些浏览器不支持 webp 编码时会静默输出其他格式
  if (blob.type && blob.type !== mime) {
    const actual = blob.type;
    const actualExt = mimeToExt(actual);
    mime = actual;
    warning = (warning ? warning + ';' : '') + '当前浏览器不支持 ' + actualExt + ' 编码,实际输出为 ' + actualExt;
  }

  // 压缩后反而更大(常见于已高度压缩/很小的图):
  // 自动或原格式模式 → 保留原图;用户明确指定转格式 → 输出但提示
  const explicitFmt = opts.outputFormat === 'jpeg' || opts.outputFormat === 'webp' || opts.outputFormat === 'png';
  if (blob.size >= originalSize) {
    if (!explicitFmt && opts.scaleMode === 'none') {
      blob = file;
      mime = file.type;
      warning = (warning ? warning + ';' : '') + '该图片已很紧凑,压缩后体积未减小,已保留原图';
    } else {
      warning = (warning ? warning + ';' : '') + '注意:压缩后体积未减小(原图已很紧凑)';
    }
  }

  return {
    blob,
    fileName: changeExt(file.name, mimeToExt(mime)),
    width: outW,
    height: outH,
    originalSize,
    newSize: blob.size,
    warning
  };
}
