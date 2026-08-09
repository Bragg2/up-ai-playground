(() => {
    'use strict';

    const isCoarsePointer = matchMedia('(pointer: coarse)').matches;
    const MAX_SOURCE_EDGE = isCoarsePointer ? 2048 : 2560;
    const MAX_UPLOAD_BYTES = (isCoarsePointer ? 40 : 80) * 1024 * 1024;
    const MAX_HISTORY = 32;

    const $ = (id) => document.getElementById(id);
    const previewCanvas = $('previewCanvas');
    const canvasWrap = $('canvasWrap');
    const emptyState = $('emptyState');
    const interactionHint = $('interactionHint');
    const ctx = previewCanvas.getContext('2d', { alpha: false });

    const bgInput = $('bgInput');
    const materialInput = $('materialInput');

    const BUILTIN_RAIN_A = './assets/rain-a.jpg';
    const BUILTIN_RAIN_B = './assets/rain-b.jpg';

    const state = {
      mode: 'material',
      image: null,
      imageName: '',
      sourceW: 0,
      sourceH: 0,
      processedW: 0,
      processedH: 0,
      downscaled: false,
      sourceCanvas: document.createElement('canvas'),
      material: {
        image: null,
        imageName: '',
        x: .5,
        y: .5,
        scale: .5,
        removeWhite: true,
        maskAlpha: null,
        maskNoWhite: null
      },
      strokes: [],
      look: {
        topBlur: 1,
        topOpacity: 1,
        bottomBlur: 14,
        bottomOpacity: .93,
        fog: .18,
        rainA: .86,
        rainB: 1, 
        rainAEnabled: true,
        rainBEnabled: true,
        brushSize: 34,
        brushSoft: .22
      },
      history: [],
      historyIndex: -1,
      pointer: null,
      raf: 0,
      rainSeed: 918273
    };

    const scratch = {
      top: document.createElement('canvas'),
      mask: document.createElement('canvas'),
      blurBase: document.createElement('canvas'),
      blurSmall: document.createElement('canvas')
    };

    const rainAssets = {
      A: null,
      B: null,
      ready: false
    };

    function loadImageFromDataURI(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('内置雨滴纹理解码失败'));
        img.src = src;
      });
    }

    async function loadBuiltinRainAssets() {
      try {
        const [a, b] = await Promise.all([
          loadImageFromDataURI(BUILTIN_RAIN_A),
          loadImageFromDataURI(BUILTIN_RAIN_B)
        ]);
        rainAssets.A = a;
        rainAssets.B = b;
        rainAssets.ready = true;
        scheduleRender();
      } catch (err) {
        console.error('雨滴纹理加载失败：', err);
      }
    }

    function toast(message) {
      const el = $('toast');
      el.textContent = message;
      el.classList.add('show');
      clearTimeout(toast._t);
      toast._t = setTimeout(() => el.classList.remove('show'), 1800);
    }

    function setCanvasAspect(w, h) {
      if (!w || !h) return;
      const ratio = w / h;
      canvasWrap.style.aspectRatio = `${w} / ${h}`;

      // 精确按背景图宽高比决定预览区，不再被默认 3:4 或 max-height 挤压变形。
      const shell = canvasWrap.parentElement;
      const shellStyle = getComputedStyle(shell);
      const horizontalPadding = (parseFloat(shellStyle.paddingLeft) || 0) + (parseFloat(shellStyle.paddingRight) || 0);
      const availableW = Math.max(1, shell.clientWidth - horizontalPadding);
      let displayW = availableW;
      let displayH = displayW / ratio;

      if (window.innerWidth <= 820) {
        // 手机端预览区固定为屏幕高度的 2/5；照片只做 contain，完整显示且居中。
        const availableH = Math.max(1, shell.clientHeight);
        const maxW = Math.max(1, shell.clientWidth - horizontalPadding);

        displayW = maxW;
        displayH = displayW / ratio;
        if (displayH > availableH) {
          displayH = availableH;
          displayW = displayH * ratio;
        }
        if (displayW > maxW) {
          displayW = maxW;
          displayH = displayW / ratio;
        }
      } else {
        const maxH = Math.max(260, window.innerHeight - 190);
        if (displayH > maxH) {
          displayH = maxH;
          displayW = displayH * ratio;
        }
      }

      canvasWrap.style.width = `${Math.round(displayW)}px`;
      canvasWrap.style.height = `${Math.round(displayH)}px`;
    }

    function updateStatus() {
      if (!state.image) {
        $('statusText').textContent = '未上传背景图';
        return;
      }
      const ratioText = `${state.sourceW}:${state.sourceH}`;
      const note = state.downscaled
        ? ` · 原图 ${state.sourceW}×${state.sourceH}px，按原图比例安全缩放`
        : ' · 与原图尺寸一致';
      $('statusText').textContent = `导出 ${state.processedW}×${state.processedH}px · 原图比例 ${ratioText}${note}`;
    }

    let heicLoaderPromise = null;

    function likelyHeic(file) {
      const name = (file?.name || '').toLowerCase();
      const type = (file?.type || '').toLowerCase();
      return /\.(heic|heif)$/.test(name) || /heic|heif/.test(type);
    }

    function loadHeicConverter() {
      if (window.HeicTo) return Promise.resolve(window.HeicTo);
      if (heicLoaderPromise) return heicLoaderPromise;
      heicLoaderPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/heic-to@1.5.2/dist/iife/heic-to.js';
        script.async = true;
        const timer = setTimeout(() => reject(new Error('HEIC 转换组件加载超时')), 12000);
        script.onload = () => {
          clearTimeout(timer);
          window.HeicTo ? resolve(window.HeicTo) : reject(new Error('HEIC 转换组件不可用'));
        };
        script.onerror = () => { clearTimeout(timer); reject(new Error('HEIC 转换组件加载失败')); };
        document.head.appendChild(script);
      });
      return heicLoaderPromise;
    }

    function htmlImageFromBlob(blob) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('HTMLImageElement 无法解码该图片')); };
        img.src = url;
      });
    }

    function htmlImageFromDataURL(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('FileReader 读取失败'));
        reader.onload = () => {
          const img = new Image();
          img.decoding = 'async';
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('DataURL 图片解码失败'));
          img.src = reader.result;
        };
        reader.readAsDataURL(blob);
      });
    }

    async function imageFromBlob(blob) {
      // 优先使用 createImageBitmap：对手机大图通常更省内存。
      if ('createImageBitmap' in window) {
        try {
          return await createImageBitmap(blob, { imageOrientation: 'from-image' });
        } catch (_) {
          try { return await createImageBitmap(blob); } catch (_) {}
        }
      }
      try {
        return await htmlImageFromBlob(blob);
      } catch (_) {
        // 部分 Safari / WebView 对 blob URL 兼容性不稳定，最后再退回 DataURL。
        return await htmlImageFromDataURL(blob);
      }
    }

    async function decodeUploadFile(file) {
      try {
        return { image: await imageFromBlob(file), convertedFromHeic: false };
      } catch (nativeErr) {
        if (!likelyHeic(file)) throw nativeErr;

        // HEIC/HEIF 在部分 Chrome / Android / Windows 浏览器无法原生解码。
        // 仅在真的需要时动态加载转换器，转换过程仍然只发生在浏览器本地。
        const HeicTo = await loadHeicConverter();
        const converted = await HeicTo({
          blob: file,
          type: 'image/jpeg',
          quality: 0.92
        });
        return { image: await imageFromBlob(converted), convertedFromHeic: true };
      }
    }

    async function loadBackground(file) {
      if (!file) return;
      if (file.size > MAX_UPLOAD_BYTES) {
        toast(`图片过大，请选择 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 以内的图片`);
        return;
      }

      toast(likelyHeic(file) ? '正在读取 HEIC 照片…' : '正在读取背景图…');

      let decoded;
      try {
        decoded = await decodeUploadFile(file);
      } catch (err) {
        console.error('背景图解码失败：', err);
        if (likelyHeic(file)) {
          toast('HEIC 读取失败，请联网后重试，或先转为 JPG / PNG');
        } else {
          toast('背景图读取失败，请尝试 JPG / PNG / WebP');
        }
        return;
      }

      const img = decoded.image;
      try {
        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;
        if (!iw || !ih) throw new Error('无法获得图片尺寸');

        const ratio = Math.min(1, MAX_SOURCE_EDGE / Math.max(iw, ih));
        const w = Math.max(1, Math.round(iw * ratio));
        const h = Math.max(1, Math.round(ih * ratio));

        state.image = { loaded: true };
        state.imageName = file.name || 'rain-window';
        state.sourceW = iw;
        state.sourceH = ih;
        state.processedW = w;
        state.processedH = h;
        state.downscaled = ratio < .999;

        const sc = state.sourceCanvas;
        sc.width = w; sc.height = h;
        const sctx = sc.getContext('2d');
        sctx.clearRect(0, 0, w, h);
        sctx.imageSmoothingEnabled = true;
        sctx.imageSmoothingQuality = 'high';
        sctx.drawImage(img, 0, 0, w, h);

        // 背景已经复制进 sourceCanvas，释放原始大图，降低手机内存压力。
        if (typeof img.close === 'function') img.close();

        state.strokes = [];
        state.material.image = null;
        state.material.imageName = '';
        state.material.maskAlpha = null;
        state.material.maskNoWhite = null;
        state.material.x = .5;
        state.material.y = .5;
        state.material.scale = .5;

        syncActionBarPlacement();
        setCanvasAspect(w, h);
        canvasWrap.classList.add('has-image');
        emptyState.classList.add('hidden');
        resetHistory();
        resizePreview();
        updateStatus();
        scheduleRender();
        toast(decoded.convertedFromHeic ? 'HEIC 已转换并载入' : '背景图已载入');
      } catch (err) {
        console.error('背景图处理失败：', err);
        try { if (typeof img.close === 'function') img.close(); } catch (_) {}
        state.image = null;
        toast('图片处理失败，可能是尺寸过大或浏览器内存不足');
      }
    }

    async function loadMaterial(file) {
      if (!file || !state.image) return;
      if (file.size > MAX_UPLOAD_BYTES) { toast('素材图过大，请换一张较小的图片'); return; }
      try {
        const decoded = await decodeUploadFile(file);
        state.material.image = decoded.image;
        state.material.imageName = file.name || 'material';
        const prepared = prepareMaterialMasks(state.material.image);
        state.material.maskAlpha = prepared.alpha;
        state.material.maskNoWhite = prepared.noWhite;
        state.material.x = .5;
        state.material.y = .5;
        state.material.scale = Number($('materialScale').value) / 100;
        pushHistory();
        scheduleRender();
        toast('素材已添加，可在画布上拖动');
      } catch (err) {
        console.error(err);
        toast('素材读取失败');
      }
    }

    function prepareMaterialMasks(img) {
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      const cap = 1200;
      const ratio = Math.min(1, cap / Math.max(iw, ih));
      const w = Math.max(1, Math.round(iw * ratio));
      const h = Math.max(1, Math.round(ih * ratio));

      const src = document.createElement('canvas');
      src.width = w; src.height = h;
      const sg = src.getContext('2d', { willReadFrequently: true });
      sg.drawImage(img, 0, 0, w, h);

      const alpha = document.createElement('canvas');
      alpha.width = w; alpha.height = h;
      const ag = alpha.getContext('2d');
      ag.drawImage(src, 0, 0);
      ag.globalCompositeOperation = 'source-in';
      ag.fillStyle = '#fff';
      ag.fillRect(0, 0, w, h);

      const noWhite = document.createElement('canvas');
      noWhite.width = w; noWhite.height = h;
      const ng = noWhite.getContext('2d', { willReadFrequently: true });
      ng.drawImage(src, 0, 0);
      try {
        const data = ng.getImageData(0, 0, w, h);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          const lum = (d[i] + d[i+1] + d[i+2]) / 3;
          const srcA = d[i+3] / 255;
          const shape = Math.max(0, Math.min(255, (238 - lum) * 5.3));
          d[i] = d[i+1] = d[i+2] = 255;
          d[i+3] = Math.round(srcA * shape);
        }
        ng.putImageData(data, 0, 0);
      } catch (_) {
        ng.globalCompositeOperation = 'source-in';
        ng.fillStyle = '#fff';
        ng.fillRect(0, 0, w, h);
      }
      return { alpha, noWhite };
    }

    function previewDpr() {
      if (isCoarsePointer || window.innerWidth <= 820) return 1;
      return Math.min(window.devicePixelRatio || 1, 1.5);
    }

    function resizePreview() {
      const rect = canvasWrap.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = previewDpr();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (previewCanvas.width !== w || previewCanvas.height !== h) {
        previewCanvas.width = w;
        previewCanvas.height = h;
      }
      scheduleRender();
    }

    function fitCanvas(c, w, h) {
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      return c.getContext('2d');
    }

    function drawImageCover(g, image, w, h, filter = 'none', alpha = 1) {
      g.save();
      // 乘上当前 globalAlpha，避免子函数把雨滴层 slider 的透明度覆盖成 1。
      g.globalAlpha *= alpha;
      g.filter = filter;
      const iw = image.width || image.naturalWidth;
      const ih = image.height || image.naturalHeight;
      const overscan = filter && filter !== 'none' ? 1.06 : 1;
      const scale = Math.max(w / iw, h / ih) * overscan;
      const dw = iw * scale;
      const dh = ih * scale;
      g.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
      g.restore();
    }

    function drawBlurredCover(g, image, w, h, blurPx, alpha = 1) {
      const radius = Math.max(0, Number(blurPx) || 0);
      if (radius < .15) {
        drawImageCover(g, image, w, h, 'none', alpha);
        return;
      }

      // Desktop Canvas filter is crisp and fast. On mobile Safari/WebView the
      // Canvas 2D `filter: blur()` implementation can be missing or silently ignored,
      // so coarse-pointer/mobile devices use a downsample/upscale blur instead.
      if (!isCoarsePointer && window.innerWidth > 820) {
        drawImageCover(g, image, w, h, `blur(${radius}px)`, alpha);
        return;
      }

      const baseG = fitCanvas(scratch.blurBase, w, h);
      baseG.setTransform(1,0,0,1,0,0);
      baseG.clearRect(0,0,w,h);
      baseG.globalCompositeOperation = 'source-over';
      baseG.globalAlpha = 1;
      baseG.filter = 'none';
      baseG.imageSmoothingEnabled = true;
      baseG.imageSmoothingQuality = 'high';

      // Slight overscan avoids hard transparent edges after upscaling.
      const iw = image.width || image.naturalWidth;
      const ih = image.height || image.naturalHeight;
      const coverScale = Math.max(w / iw, h / ih) * 1.035;
      const dw = iw * coverScale;
      const dh = ih * coverScale;
      baseG.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);

      // The shrink ratio follows the slider continuously. More blur = smaller
      // intermediate bitmap = stronger low-pass filtering when scaled back up.
      const shrink = Math.max(.075, Math.min(.96, 1 / (1 + radius * .16)));
      const sw = Math.max(2, Math.round(w * shrink));
      const sh = Math.max(2, Math.round(h * shrink));
      const smallG = fitCanvas(scratch.blurSmall, sw, sh);
      smallG.setTransform(1,0,0,1,0,0);
      smallG.clearRect(0,0,sw,sh);
      smallG.globalCompositeOperation = 'source-over';
      smallG.globalAlpha = 1;
      smallG.filter = 'none';
      smallG.imageSmoothingEnabled = true;
      smallG.imageSmoothingQuality = 'high';
      smallG.drawImage(scratch.blurBase, 0, 0, w, h, 0, 0, sw, sh);

      g.save();
      g.globalAlpha *= alpha;
      g.filter = 'none';
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(scratch.blurSmall, 0, 0, sw, sh, 0, 0, w, h);
      g.restore();
    }

    function normalizedFontSize(sizePx, w, h) {
      const base = Math.min(w, h) / 700;
      return Math.max(10, sizePx * base);
    }

    function drawSoftStroke(g, pts, w, h, sizeNorm, soft) {
      if (!pts.length) return;
      const size = Math.max(1, sizeNorm * Math.min(w, h));
      const blur = Math.max(0, size * soft * .7);
      g.save();
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = '#fff';
      g.fillStyle = '#fff';
      g.lineWidth = size;
      g.shadowColor = '#fff';
      g.shadowBlur = blur;
      g.beginPath();
      const p0 = pts[0];
      g.moveTo(p0.x * w, p0.y * h);
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        g.lineTo(p.x * w, p.y * h);
      }
      if (pts.length === 1) {
        g.beginPath();
        g.arc(p0.x * w, p0.y * h, size / 2, 0, Math.PI * 2);
        g.fill();
      } else {
        g.stroke();
      }
      g.restore();
    }

    function renderMaterialMask(g, w, h) {
      const m = state.material;
      if (!m.image) return;
      const maskImage = m.removeWhite ? m.maskNoWhite : m.maskAlpha;
      if (!maskImage) return;
      const aspect = maskImage.width / maskImage.height;
      let dw = Math.min(w, h) * m.scale;
      let dh = dw / aspect;
      if (dh > h * 1.8) { dh = h * 1.8; dw = dh * aspect; }
      const x = m.x * w - dw / 2;
      const y = m.y * h - dh / 2;
      g.drawImage(maskImage, x, y, dw, dh);
    }

    function buildMask(w, h) {
      const g = fitCanvas(scratch.mask, w, h);
      g.clearRect(0, 0, w, h);

      // 素材图 / 画笔是两种互斥的创作方式。
      // 用户切换到哪一种，就只使用哪一种生成擦窗蒙版，不彼此叠加。
      if (state.mode === 'material') {
        renderMaterialMask(g, w, h);
      } else if (state.mode === 'brush') {
        for (const s of state.strokes) drawSoftStroke(g, s.points, w, h, s.size, s.soft);
      }
      return scratch.mask;
    }

    function mulberry32(seed) {
      return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }

    function drawRain(g, w, h, layer) {
      const rnd = mulberry32(state.rainSeed + (layer === 'A' ? 1009 : 2099));
      const minDim = Math.min(w, h);
      const count = layer === 'A' ? Math.round(Math.min(165, Math.max(45, minDim / 5.8))) : Math.round(Math.min(420, Math.max(120, minDim / 2.2)));

      for (let i = 0; i < count; i++) {
        const x = rnd() * w;
        const y = rnd() * h;
        const base = layer === 'A' ? minDim * (.005 + rnd() * .014) : minDim * (.0015 + rnd() * .0045);
        const stretch = layer === 'A' ? (.85 + rnd() * 1.9) : (.8 + rnd() * .7);
        const rx = base * (.6 + rnd() * .8);
        const ry = base * stretch;

        g.save();
        g.translate(x, y);
        g.rotate((rnd() - .5) * .18);

        const grad = g.createRadialGradient(-rx * .28, -ry * .3, Math.max(1, rx * .05), 0, 0, Math.max(rx, ry));
        grad.addColorStop(0, 'rgba(255,255,255,.9)');
        grad.addColorStop(.22, 'rgba(255,255,255,.25)');
        grad.addColorStop(.62, 'rgba(15,20,25,.08)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.ellipse(0, 0, rx * 1.35, ry * 1.35, 0, 0, Math.PI * 2);
        g.fill();

        g.strokeStyle = layer === 'A' ? 'rgba(255,255,255,.62)' : 'rgba(255,255,255,.5)';
        g.lineWidth = Math.max(.6, minDim * (layer === 'A' ? .0014 : .00075));
        g.beginPath();
        g.ellipse(-rx * .08, -ry * .06, rx, ry, 0, 0, Math.PI * 2);
        g.stroke();

        if (layer === 'A' && rnd() > .74) {
          g.strokeStyle = 'rgba(255,255,255,.22)';
          g.lineWidth = Math.max(1, rx * .38);
          g.lineCap = 'round';
          g.beginPath();
          g.moveTo(rx * .05, ry * .65);
          g.lineTo(rx * .02, ry * (1.35 + rnd() * 2.8));
          g.stroke();
        }
        g.restore();
      }
    }

    function drawRainTexture(g, w, h, image, layer) {
      if (!image) return;
      const filter = layer === 'A' ? 'contrast(135%) brightness(108%)' : 'contrast(128%) brightness(104%)';
      drawImageCover(g, image, w, h, filter, 1);
    }

    function renderScene(target, w, h, source) {
      const g = target.getContext('2d', { alpha: false });
      g.setTransform(1,0,0,1,0,0);
      g.clearRect(0,0,w,h);
      g.fillStyle = '#e9e9e9';
      g.fillRect(0,0,w,h);

      const minDim = Math.min(w, h);
      const blurScale = minDim / 700;

      // 1) 强模糊底图
      drawBlurredCover(g, source, w, h, Math.max(0, state.look.bottomBlur * blurScale), state.look.bottomOpacity);

      // 2) 轻雾层
      if (state.look.fog > 0) {
        g.save();
        g.globalAlpha = state.look.fog;
        const fogGrad = g.createLinearGradient(0,0,w,h);
        fogGrad.addColorStop(0, '#eef2f3');
        fogGrad.addColorStop(.55, '#dfe5e7');
        fogGrad.addColorStop(1, '#f4f4f2');
        g.fillStyle = fogGrad;
        g.fillRect(0,0,w,h);
        g.restore();
      }

      // 3) 轻模糊顶图，受 mask 控制
      const topG = fitCanvas(scratch.top, w, h);
      topG.clearRect(0,0,w,h);
      drawBlurredCover(topG, source, w, h, Math.max(0, state.look.topBlur * blurScale), state.look.topOpacity);
      topG.globalCompositeOperation = 'destination-in';
      topG.drawImage(buildMask(w,h), 0, 0);
      topG.globalCompositeOperation = 'source-over';
      g.drawImage(scratch.top,0,0);

      // 4) 雨滴双层：优先使用真实雨滴纹理，加载失败时回退到程序化水珠
      if (state.look.rainAEnabled && state.look.rainA > 0) {
        g.save();
        g.globalAlpha = state.look.rainA;
        g.globalCompositeOperation = 'screen';
        if (rainAssets.ready && rainAssets.A) {
          drawRainTexture(g, w, h, rainAssets.A, 'A');
        } else {
          drawRain(g, w, h, 'A');
        }
        g.restore();
      }
      if (state.look.rainBEnabled && state.look.rainB > 0) {
        g.save();
        g.globalAlpha = state.look.rainB;
        g.globalCompositeOperation = 'soft-light';
        if (rainAssets.ready && rainAssets.B) {
          drawRainTexture(g, w, h, rainAssets.B, 'B');
        } else {
          drawRain(g, w, h, 'B');
        }
        g.restore();
      }

      // 5) 轻微玻璃高光，增加“窗”的整体感
      g.save();
      const gloss = g.createLinearGradient(0,0,w,h);
      gloss.addColorStop(0, 'rgba(255,255,255,.12)');
      gloss.addColorStop(.35, 'rgba(255,255,255,0)');
      gloss.addColorStop(1, 'rgba(255,255,255,.03)');
      g.fillStyle = gloss;
      g.fillRect(0,0,w,h);
      g.restore();
    }

    function renderPreview() {
      state.raf = 0;
      const w = previewCanvas.width;
      const h = previewCanvas.height;
      if (!w || !h) return;
      if (!state.image) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0,0,w,h);
        return;
      }
      renderScene(previewCanvas, w, h, state.sourceCanvas);
    }

    function scheduleRender() {
      if (state.raf) return;
      state.raf = requestAnimationFrame(renderPreview);
    }

    function creativeSnapshot() {
      return {
        strokes: state.strokes.map(s => ({ size: s.size, soft: s.soft, points: s.points.map(p => ({x:p.x, y:p.y})) })),
        material: {
          image: state.material.image,
          imageName: state.material.imageName,
          maskAlpha: state.material.maskAlpha,
          maskNoWhite: state.material.maskNoWhite,
          x: state.material.x, y: state.material.y, scale: state.material.scale, removeWhite: state.material.removeWhite
        }
      };
    }

    function snapshotSignature(s) {
      return JSON.stringify({
        strokes: s.strokes,
        material: { imageName:s.material.imageName, x:s.material.x, y:s.material.y, scale:s.material.scale, removeWhite:s.material.removeWhite, hasImage:!!s.material.image }
      });
    }

    function restoreCreativeState(s) {
      state.strokes = s.strokes.map(st => ({ size:st.size, soft:st.soft, points:st.points.map(p=>({x:p.x,y:p.y})) }));
      Object.assign(state.material, s.material);
      syncCreativeControls();
      scheduleRender();
    }

    function resetHistory() {
      state.history = [creativeSnapshot()];
      state.historyIndex = 0;
      updateHistoryButtons();
    }

    function pushHistory() {
      if (!state.image) return;
      const snap = creativeSnapshot();
      if (state.history[state.historyIndex] && snapshotSignature(state.history[state.historyIndex]) === snapshotSignature(snap)) return;
      state.history = state.history.slice(0, state.historyIndex + 1);
      state.history.push(snap);
      if (state.history.length > MAX_HISTORY) state.history.shift();
      state.historyIndex = state.history.length - 1;
      updateHistoryButtons();
    }

    function updateHistoryButtons() {
      $('undoBtn').disabled = state.historyIndex <= 0;
      $('redoBtn').disabled = state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
    }

    function undo() {
      if (state.historyIndex <= 0) return;
      state.historyIndex--;
      restoreCreativeState(state.history[state.historyIndex]);
      updateHistoryButtons();
    }

    function redo() {
      if (state.historyIndex >= state.history.length - 1) return;
      state.historyIndex++;
      restoreCreativeState(state.history[state.historyIndex]);
      updateHistoryButtons();
    }

    function clearCreative() {
      if (!state.image) return;
      if (state.mode === 'material') {
        state.material.image = null;
        state.material.imageName = '';
        state.material.maskAlpha = null;
        state.material.maskNoWhite = null;
        toast('已清空素材图');
      } else if (state.mode === 'brush') {
        state.strokes = [];
        toast('已清空画笔');
      }
      pushHistory();
      scheduleRender();
    }

    function canvasPoint(e) {
      const r = previewCanvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))
      };
    }

    function materialHit(p) {
      const m = state.material;
      if (!m.image) return false;
      const img = m.image;
      const aspect = (img.naturalWidth || img.width) / (img.naturalHeight || img.height);
      const min = Math.min(previewCanvas.width, previewCanvas.height);
      let dw = min * m.scale;
      let dh = dw / aspect;
      const nx = (dw / previewCanvas.width) / 2;
      const ny = (dh / previewCanvas.height) / 2;
      return p.x >= m.x - nx && p.x <= m.x + nx && p.y >= m.y - ny && p.y <= m.y + ny;
    }

    function onPointerDown(e) {
      if (!state.image) return;
      const p = canvasPoint(e);
      previewCanvas.setPointerCapture?.(e.pointerId);

      if (state.mode === 'brush') {
        const sizeNorm = state.look.brushSize / 700;
        state.strokes.push({ size: sizeNorm, soft: state.look.brushSoft, points: [p] });
        state.pointer = { type: 'brush', pointerId: e.pointerId };
        scheduleRender();
        e.preventDefault();
        return;
      }

      if (state.mode === 'material' && state.material.image && materialHit(p)) {
        state.pointer = { type: 'material', pointerId: e.pointerId, dx: p.x - state.material.x, dy: p.y - state.material.y };
        e.preventDefault();
        return;
      }
    }

    function onPointerMove(e) {
      if (!state.pointer || state.pointer.pointerId !== e.pointerId) return;
      const p = canvasPoint(e);
      if (state.pointer.type === 'brush') {
        const stroke = state.strokes[state.strokes.length - 1];
        const last = stroke.points[stroke.points.length - 1];
        const dx = p.x - last.x, dy = p.y - last.y;
        if (dx*dx + dy*dy > .000006) stroke.points.push(p);
      } else if (state.pointer.type === 'material') {
        state.material.x = Math.max(-.2, Math.min(1.2, p.x - state.pointer.dx));
        state.material.y = Math.max(-.2, Math.min(1.2, p.y - state.pointer.dy));
      }
      scheduleRender();
      e.preventDefault();
    }

    function onPointerUp(e) {
      if (!state.pointer || state.pointer.pointerId !== e.pointerId) return;
      pushHistory();
      state.pointer = null;
      e.preventDefault();
    }

    function setMode(mode) {
      state.mode = mode;
      document.querySelectorAll('#contentTabs .tab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
      document.querySelectorAll('[data-panel]').forEach(p => p.classList.toggle('active', p.dataset.panel === mode));
      interactionHint.textContent = mode === 'brush' ? '画笔：在画布上拖动' : '素材：拖动调整位置';
      previewCanvas.style.cursor = mode === 'brush' ? 'crosshair' : 'grab';
      scheduleRender();
    }

    function setLayerPanel(layer) {
      document.querySelectorAll('#layerTabs .tab').forEach(b => b.classList.toggle('active', b.dataset.layer === layer));
      document.querySelectorAll('[data-layer-panel]').forEach(p => p.classList.toggle('active', p.dataset.layerPanel === layer));
    }

    function syncCreativeControls() {
      $('materialScale').value = Math.round(state.material.scale * 100);
      $('materialScaleVal').textContent = `${Math.round(state.material.scale*100)}%`;
      $('removeWhite').checked = state.material.removeWhite;
    }

    function bindRange(id, valueId, format, onInput, onChange = null) {
      const el = $(id);
      const value = $(valueId);
      const run = () => {
        value.textContent = format(Number(el.value));
        onInput(Number(el.value));
        scheduleRender();
      };
      el.addEventListener('input', run);
      el.addEventListener('change', () => { if (onChange) onChange(Number(el.value)); });
    }

    bindRange('materialScale','materialScaleVal',v=>`${v}%`, v=>state.material.scale=v/100, ()=>pushHistory());
    bindRange('brushSize','brushSizeVal',v=>`${v}px`, v=>state.look.brushSize=v);
    bindRange('brushSoft','brushSoftVal',v=>`${v}%`, v=>state.look.brushSoft=v/100);

    bindRange('topBlur','topBlurVal',v=>`${v}px`, v=>state.look.topBlur=v);
    bindRange('topOpacity','topOpacityVal',v=>`${v}%`, v=>state.look.topOpacity=v/100);
    bindRange('bottomBlur','bottomBlurVal',v=>`${v}px`, v=>state.look.bottomBlur=v);
    bindRange('bottomOpacity','bottomOpacityVal',v=>`${v}%`, v=>state.look.bottomOpacity=v/100);
    bindRange('fog','fogVal',v=>`${v}%`, v=>state.look.fog=v/100);
    bindRange('rainA','rainAVal',v=>`${v}%`, v=>state.look.rainA=v/100);
    bindRange('rainB','rainBVal',v=>`${v}%`, v=>state.look.rainB=v/100);

    $('rainAEnabled').addEventListener('change', e => { state.look.rainAEnabled = e.target.checked; scheduleRender(); });
    $('rainBEnabled').addEventListener('change', e => { state.look.rainBEnabled = e.target.checked; scheduleRender(); });
    $('removeWhite').addEventListener('change', e => { state.material.removeWhite = e.target.checked; pushHistory(); scheduleRender(); });

    $('contentTabs').addEventListener('click', e => {
      const b = e.target.closest('.tab'); if (b) setMode(b.dataset.mode);
    });
    $('layerTabs').addEventListener('click', e => {
      const b = e.target.closest('.tab'); if (b) setLayerPanel(b.dataset.layer);
    });

    emptyState.addEventListener('click', () => bgInput.click());
    $('changeBgBtn').addEventListener('click', () => bgInput.click());
    bgInput.addEventListener('change', e => { loadBackground(e.target.files?.[0]); e.target.value=''; });

    $('uploadMaterialBtn').addEventListener('click', () => {
      if (!state.image) { toast('请先上传背景图'); return; }
      materialInput.click();
    });
    materialInput.addEventListener('change', e => { loadMaterial(e.target.files?.[0]); e.target.value=''; });

    $('undoBtn').addEventListener('click', undo);
    $('redoBtn').addEventListener('click', redo);
    $('clearBtn').addEventListener('click', clearCreative);

    previewCanvas.addEventListener('pointerdown', onPointerDown);
    previewCanvas.addEventListener('pointermove', onPointerMove);
    previewCanvas.addEventListener('pointerup', onPointerUp);
    previewCanvas.addEventListener('pointercancel', onPointerUp);

    $('resetLookBtn').addEventListener('click', () => {
      const defaults = { topBlur:1, topOpacity:1, bottomBlur:14, bottomOpacity:.93, fog:.18, rainA:.86, rainB:1, rainAEnabled:true, rainBEnabled:true, brushSize:34, brushSoft:.22 };
      Object.assign(state.look, defaults);
      const pairs = [
        ['topBlur',1],['topOpacity',100],['bottomBlur',14],['bottomOpacity',93],['fog',18],['rainA',86],['rainB',100],['brushSize',34],['brushSoft',22]
      ];
      for (const [id,v] of pairs) { $(id).value = v; $(id).dispatchEvent(new Event('input')); }
      $('rainAEnabled').checked = true;
      $('rainBEnabled').checked = true;
      scheduleRender();
      toast('已恢复默认参数');
    });


    async function canvasToPngBlob(canvas) {
      return await new Promise((resolve, reject) => {
        try {
          canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error('toBlob 返回空结果'));
          }, 'image/png');
        } catch (err) {
          reject(err);
        }
      });
    }

    async function triggerExportDownload(blob, filename) {
      const isDesktop = !isCoarsePointer && window.innerWidth > 820;

      if (isDesktop) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        toast('已开始下载 PNG');
        return true;
      }

      const file = new File([blob], filename, { type: 'image/png' });
      if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: filename });
          toast('已打开系统分享 / 保存');
          return true;
        } catch (err) {
          if (err && err.name !== 'AbortError') console.warn('navigator.share 失败，改用其他导出方式', err);
        }
      }

      const url = URL.createObjectURL(blob);
      const win = window.open('', '_blank');
      if (win) {
        win.document.write(`<title>导出图片</title><img src="${url}" style="max-width:100%;height:auto;display:block;margin:0 auto;" />`);
        win.document.close();
        toast('已打开导出图片，请长按保存');
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return true;
      }
      throw new Error('导出失败');
    }

    $('exportBtn').addEventListener('click', async () => {
      if (!state.image) { toast('请先上传背景图'); return; }
      const btn = $('exportBtn');
      const old = btn.textContent;
      btn.disabled = true;
      btn.textContent = '正在导出…';
      try {
        const out = document.createElement('canvas');
        out.width = state.processedW;
        out.height = state.processedH;
        renderScene(out, out.width, out.height, state.sourceCanvas);
        const blob = await canvasToPngBlob(out);
        const base = (state.imageName || 'rain-window').replace(/\.[^.]+$/, '').replace(/[^\w\-一-龥]+/g, '-');
        const filename = `${base || 'rain-window'}-rain-window.png`;
        await triggerExportDownload(blob, filename);
      } catch (err) {
        console.error(err);
        try {
          const out = document.createElement('canvas');
          out.width = state.processedW;
          out.height = state.processedH;
          renderScene(out, out.width, out.height, state.sourceCanvas);
          const dataUrl = out.toDataURL('image/png');
          const win = window.open('', '_blank');
          if (win) {
            win.document.write(`<title>导出图片</title><img src="${dataUrl}" style="max-width:100%;height:auto;display:block;margin:0 auto;" />`);
            win.document.close();
            toast('已打开导出图片，请长按或右键保存');
          } else {
            toast('导出失败：请允许浏览器打开新窗口后重试');
          }
        } catch (err2) {
          console.error(err2);
          toast('导出失败，请稍后再试');
        }
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    });

    // 快捷键：桌面端 Cmd/Ctrl + Z / Shift + Z
    window.addEventListener('keydown', e => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.target.matches('input')) return;
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      }
    });

    const actionBar = document.querySelector('.action-bar');
    const brushActionHost = $('brushActionHost');
    const stageShell = document.querySelector('.stage-shell');

    function syncActionBarPlacement() {
      const mobile = window.innerWidth <= 820;
      if (mobile) {
        if (brushActionHost && actionBar && actionBar.parentElement !== brushActionHost) {
          brushActionHost.appendChild(actionBar);
        }
      } else {
        if (stageShell && actionBar && actionBar.parentElement !== stageShell) {
          stageShell.appendChild(actionBar);
        }
      }
    }

    const ro = new ResizeObserver(() => resizePreview());
    ro.observe(canvasWrap);

    function refitPreviewToBackground() {
      if (state.image && state.sourceW && state.sourceH) setCanvasAspect(state.sourceW, state.sourceH);
      resizePreview();
    }
    window.addEventListener('resize', () => { syncActionBarPlacement(); refitPreviewToBackground(); }, { passive: true });
    window.addEventListener('orientationchange', () => setTimeout(() => { syncActionBarPlacement(); refitPreviewToBackground(); }, 120));

    loadBuiltinRainAssets();
    syncCreativeControls();
    syncActionBarPlacement();
    resizePreview();
  })();
