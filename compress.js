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
 * @returns {Promise<{blob: Blob, fileName: string, width: number, height: number,
 *          originalSize: number, newSize: number, warning?: string}>}
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

  // 若压缩后反而更大(常见于已高度压缩的 jpg/png 小图),保留原文件
  if (blob.size >= originalSize && mime === file.type && opts.scaleMode === 'none') {
    blob = file;
    warning = (warning ? warning + ';' : '') + '该图片已很紧凑,压缩后体积未减小,已保留原图';
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
