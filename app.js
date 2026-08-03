/* app.js - 页面交互:上传、参数、处理队列、结果渲染、批量打包 */

(function () {
  'use strict';

  // ---- DOM 引用 ----
  const $ = (id) => document.getElementById(id);
  const uploadZone = $('uploadZone');
  const fileInput = $('fileInput');
  const pickBtn = $('pickBtn');
  const paramsPanel = $('paramsPanel');
  const resultsSection = $('resultsSection');
  const cardList = $('cardList');
  const zipBtn = $('zipBtn');
  const progressText = $('progressText');
  const progressBarWrap = $('progressBarWrap');
  const progressBarInner = $('progressBarInner');
  const qualityRange = $('qualityRange');
  const qualityValue = $('qualityValue');
  const scaleMode = $('scaleMode');
  const targetWidth = $('targetWidth');
  const targetRatio = $('targetRatio');
  const widthRow = $('widthRow');
  const ratioRow = $('ratioRow');
  const outputFormat = $('outputFormat');
  const presetSelect = $('presetSelect');
  const presetHint = $('presetHint');
  const targetKB = $('targetKB');
  const formatHint = $('formatHint');

  // ---- 证件照预设表(与 index.html 下拉一致) ----
  const PRESETS = {
    '1inch':      { name: '一寸',     w: 295, h: 413 },
    'small1inch': { name: '小一寸',   w: 260, h: 378 },
    'big1inch':   { name: '大一寸',   w: 390, h: 567 },
    '2inch':      { name: '二寸',     w: 413, h: 579 },
    'small2inch': { name: '小二寸',   w: 413, h: 531 },
    'big2inch':   { name: '大二寸',   w: 413, h: 626 },
    'idcard':     { name: '身份证',   w: 358, h: 441 },
    'visa':       { name: '美国签证', w: 600, h: 600 }
  };

  // ---- 设备判断:手机显示"存相册",电脑显示"下载" ----
  function isMobileDevice() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
      (navigator.maxTouchPoints > 0 && window.innerWidth < 768);
  }
  const IS_MOBILE = isMobileDevice();

  // ---- 状态 ----
  let files = [];          // 当前待处理的 File 列表
  let results = [];        // 处理结果(与 files 对齐)
  let processing = false;  // 是否正在处理
  let debounceTimer = null;
  let gen = 0;             // 队列代次,删除图片时使旧队列失效

  // ---- 读取参数 ----
  function getOptions() {
    const preset = PRESETS[presetSelect.value] || null;
    return {
      quality: parseInt(qualityRange.value, 10) || 70,
      scaleMode: preset ? 'preset' : scaleMode.value,
      targetWidth: parseInt(targetWidth.value, 10) || 1920,
      targetRatio: parseInt(targetRatio.value, 10) || 50,
      outputFormat: outputFormat.value,
      presetW: preset ? preset.w : 0,
      presetH: preset ? preset.h : 0,
      targetKB: parseInt(targetKB.value, 10) > 0 ? parseInt(targetKB.value, 10) : 0
    };
  }

  // ---- 删除单张图片 ----
  function removeFile(i) {
    files.splice(i, 1);
    results.splice(i, 1);
    gen++;                 // 让正在跑的处理队列立即失效
    processing = false;
    renderCards();
    if (files.length > 0) {
      queueProcess();      // 重新处理剩余未完成的
    } else {
      paramsPanel.hidden = true;
      resultsSection.hidden = true;
      progressBarWrap.hidden = true;
      progressText.hidden = true;
    }
  }

  // ---- 选择文件 ----
  function addFiles(fileList) {
    const incoming = Array.from(fileList).filter((f) => f.type.indexOf('image/') === 0);
    const rejected = Array.from(fileList).length - incoming.length;
    if (rejected > 0) {
      alert('已跳过 ' + rejected + ' 个非图片文件');
    }
    if (incoming.length === 0) return;
    files = files.concat(incoming);
    results = results.concat(incoming.map(() => null));
    paramsPanel.hidden = false;
    resultsSection.hidden = false;
    updateFormatHint();
    renderCards();
    queueProcess();
  }

  // ---- 根据上传的图片格式动态更新输出格式提示 ----
  function updateFormatHint() {
    const originalOpt = $('originalFmtOpt');
    const types = Array.from(new Set(files.map((f) => f.type)));
    if (types.includes('image/png')) {
      formatHint.textContent = '你上传的是 PNG,无损格式压不动;建议保持"自动"或改选 jpg/webp';
      originalOpt.textContent = '保持原格式(你的 PNG 压不动,不推荐)';
    } else if (types.includes('image/gif')) {
      formatHint.textContent = '你上传了 GIF 动态图,会按静态帧转为 jpg;建议保持"自动"';
      originalOpt.textContent = '保持原格式(GIF 会转 jpg)';
    } else if (types.length > 1) {
      formatHint.textContent = '你上传了多种格式,保持"自动"最省心';
      originalOpt.textContent = '保持原格式(按各自的原始格式)';
    } else if (types.includes('image/jpeg')) {
      formatHint.textContent = '你上传的是 jpg,可以正常压缩,保持"自动"或"保持原格式"都行';
      originalOpt.textContent = '保持原格式(你的 jpg 可直接压)';
    } else if (types.includes('image/webp')) {
      formatHint.textContent = '你上传的是 webp,可以正常压缩';
      originalOpt.textContent = '保持原格式(你的 webp 可直接压)';
    } else {
      formatHint.textContent = '选"自动"最省心,PNG 会自动转 webp 再压';
      originalOpt.textContent = '保持原格式';
    }
  }

  // ---- 处理队列 ----
  function queueProcess() {
    if (processing) return;
    processing = true;
    const myGen = ++gen;
    const opts = getOptions();
    let index = 0;
    const total = files.length;

    progressBarWrap.hidden = false;
    progressText.hidden = false;
    zipBtn.hidden = true;

    async function next() {
      if (myGen !== gen) {              // 队列已被删除操作作废
        processing = false;
        return;
      }
      if (index >= total) {
        processing = false;
        progressBarWrap.hidden = true;
        progressText.hidden = true;
        updateZipBtn();
        renderCards();
        return;
      }
      const i = index++;
      progressText.textContent = '处理中 ' + i + ' / ' + total;
      progressBarInner.style.width = Math.round((i / total) * 100) + '%';
      try {
        results[i] = await compressImage(files[i], opts);
      } catch (e) {
        results[i] = { error: e.message || '处理失败' };
      }
      if (myGen !== gen) {              // 处理过程中被删除
        processing = false;
        updateZipBtn();
        return;
      }
      renderCards();
      next();
    }
    next();
  }

  // ---- 渲染结果卡片 ----
  function renderCards() {
    cardList.innerHTML = '';
    files.forEach((file, i) => {
      const res = results[i];
      const card = document.createElement('div');
      card.className = 'card' + (res && res.error ? ' error' : '');

      // 缩略图:处理完成后显示压缩结果图(手机长按即可保存压缩后的图)
      const thumbUrl = res && res.blob ? URL.createObjectURL(res.blob) : URL.createObjectURL(file);
      const thumb = document.createElement('img');
      thumb.className = 'card-thumb';
      thumb.src = thumbUrl;
      thumb.alt = file.name;
      if (IS_MOBILE && res && res.blob) {
        thumb.title = '长按图片可保存到相册';
      }

      const body = document.createElement('div');
      body.className = 'card-body';

      const name = document.createElement('div');
      name.className = 'card-name';
      name.textContent = file.name;

      const meta = document.createElement('div');
      meta.className = 'card-meta';

      const actions = document.createElement('div');
      actions.className = 'card-actions';

      if (res && res.error) {
        meta.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'card-err';
        err.textContent = res.error;
        meta.appendChild(err);
      } else if (res) {
        const savedPct = res.originalSize > 0
          ? Math.max(0, Math.round((1 - res.newSize / res.originalSize) * 100)) : 0;
        const dims = document.createElement('span');
        dims.textContent = res.width + '×' + res.height + ' · ';
        const sizeOld = document.createElement('span');
        sizeOld.className = 'size-old';
        sizeOld.textContent = formatSize(res.originalSize);
        const arrow = document.createTextNode(' → ');
        const sizeNew = document.createElement('span');
        sizeNew.className = 'size-new';
        sizeNew.textContent = formatSize(res.newSize);
        const saved = document.createElement('span');
        saved.className = 'saved';
        saved.textContent = '省 ' + savedPct + '%';
        meta.appendChild(dims);
        meta.appendChild(sizeOld);
        meta.appendChild(arrow);
        meta.appendChild(sizeNew);
        meta.appendChild(saved);
        if (res.targetKB) {
          const targetBadge = document.createElement('span');
          targetBadge.className = 'card-target';
          targetBadge.textContent = '目标 ≤' + res.targetKB + 'KB → 实际 ' + formatSize(res.newSize);
          meta.appendChild(targetBadge);
        }
        if (res.warning) {
          const warn = document.createElement('div');
          warn.className = 'card-err';
          warn.textContent = res.warning;
          meta.appendChild(warn);
        }

        // 统一"下载"按钮(大厂风格,不随设备变文案):
        // 手机点下载 → 弹系统分享(可"存储图像"进相册);电脑 → 直接下载
        const album = document.createElement('button');
        album.className = 'btn btn-secondary';
        album.textContent = '⬇ 下载';
        album.addEventListener('click', () => {
          if (IS_MOBILE) saveToAlbum(res.blob, res.fileName);
          else downloadBlob(res.blob, res.fileName);
        });
        actions.appendChild(album);
        if (IS_MOBILE) {
          const tip = document.createElement('div');
          tip.className = 'card-err';
          tip.style.fontSize = '.75rem';
          tip.style.color = 'var(--text-muted)';
          tip.textContent = '长按图片也可保存到相册';
          body.appendChild(tip);
        }
      } else {
        meta.textContent = '处理中…';
      }

      // 删除按钮(每张图都能单独删)
      const del = document.createElement('button');
      del.className = 'btn btn-delete';
      del.textContent = '✕ 删除';
      del.addEventListener('click', () => removeFile(i));
      actions.appendChild(del);

      body.appendChild(name);
      body.appendChild(meta);
      card.appendChild(thumb);
      card.appendChild(body);
      card.appendChild(actions);
      cardList.appendChild(card);
    });
  }

  // ---- 下载 ----
  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---- 保存到相册(移动端) ----
  // 优先用系统分享面板(Web Share API),iOS 上可"存储图像"直达相册;
  // 不支持分享时退回普通下载(会进"文件",提示用户长按图片也能存相册)。
  async function saveToAlbum(blob, fileName) {
    try {
      if (navigator.canShare && navigator.share) {
        const file = new File([blob], fileName, { type: blob.type });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
          return;
        }
      }
    } catch (e) {
      // 用户取消分享或分享失败,退回下载
    }
    downloadBlob(blob, fileName);
  }

  // ---- 批量打包/存相册 ----
  function updateZipBtn() {
    const done = results.filter((r) => r && !r.error);
    const anyPending = results.some((r) => r === null);
    const show = done.length > 1 && !processing && !anyPending;
    zipBtn.hidden = !show;
    if (show) {
      zipBtn.textContent = '⬇ 下载全部';
    }
  }

  zipBtn.addEventListener('click', async () => {
    const done = results.filter((r) => r && !r.error);
    if (done.length === 0) return;

    // 手机:系统分享全部图片(可"存储图像"进相册);桌面:直接 zip 下载
    if (IS_MOBILE) {
      try {
        if (navigator.canShare && navigator.share) {
          const files = done.map((r) => new File([r.blob], r.fileName, { type: r.blob.type }));
          if (navigator.canShare({ files })) {
            await navigator.share({ files });
            return;
          }
        }
      } catch (e) {
        // 用户取消或分享失败,退回 zip
      }
    }

    // 打包 zip 下载(桌面 / 手机分享不可用时)
    if (typeof JSZip === 'undefined') {
      alert('批量打包组件加载失败(可能网络原因),请改用单张保存。');
      return;
    }
    zipBtn.disabled = true;
    zipBtn.textContent = '打包中…';
    try {
      const zip = new JSZip();
      done.forEach((r, i) => zip.file(i + '_' + r.fileName, r.blob));
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, 'compressed-images.zip');
    } catch (e) {
      alert('打包失败,请改用单张保存。');
    } finally {
      zipBtn.disabled = false;
      updateZipBtn();
    }
  });

  // ---- 事件绑定 ----
  pickBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
  uploadZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  ['dragover', 'dragenter'].forEach((evt) => {
    uploadZone.addEventListener(evt, (e) => {
      e.preventDefault();
      uploadZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    uploadZone.addEventListener(evt, (e) => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
    });
  });
  uploadZone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  // 参数联动:缩放模式切换显示对应输入
  function updateScaleRows() {
    const preset = PRESETS[presetSelect.value] || null;
    if (preset) {
      scaleMode.disabled = true;
      widthRow.classList.add('hidden');
      ratioRow.classList.add('hidden');
      presetHint.hidden = false;
      presetHint.textContent = '输出尺寸:' + preset.w + '×' + preset.h + 'px,按规格居中裁剪';
    } else {
      scaleMode.disabled = false;
      widthRow.classList.toggle('hidden', scaleMode.value !== 'width');
      ratioRow.classList.toggle('hidden', scaleMode.value !== 'ratio');
      presetHint.hidden = true;
    }
  }
  scaleMode.addEventListener('change', updateScaleRows);
  presetSelect.addEventListener('change', updateScaleRows);
  updateScaleRows();

  // 参数变化 → 重新处理(滑块防抖)
  function onParamChange() {
    qualityValue.textContent = qualityRange.value + '%';
    if (files.length === 0) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      results = results.map(() => null);
      renderCards();
      queueProcess();
    }, 300);
  }
  qualityRange.addEventListener('input', onParamChange);
  scaleMode.addEventListener('change', onParamChange);
  targetWidth.addEventListener('change', onParamChange);
  targetRatio.addEventListener('change', onParamChange);
  outputFormat.addEventListener('change', onParamChange);
  presetSelect.addEventListener('change', onParamChange);
  targetKB.addEventListener('input', onParamChange);

  // 阻止整页拖放导致浏览器打开文件
  ['dragover', 'drop'].forEach((evt) => {
    window.addEventListener(evt, (e) => e.preventDefault());
  });
})();
