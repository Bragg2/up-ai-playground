const state = {
  activeMode: "photo",
  activeLayer: "top",
  baseImage: null,
  photoOverlayImage: null,
  rainAImage: null,
  rainBImage: null,
  photo: {
    size: 50,
    offsetX: 0,
    offsetY: 0,
  },
  line: {
    size: 12,
    strokes: [],
    redo: [],
  },
  text: {
    value: "",
    size: 48,
    offsetX: 0,
    offsetY: 0,
  },
  interaction: null,
  renderToken: 0,
};

const controls = {
  baseInput: document.getElementById("base-input"),
  overlayInput: document.getElementById("overlay-input"),
  overlayUploadButton: document.getElementById("overlay-upload-button"),
  overlayTriggerText: document.getElementById("overlay-trigger-text"),
  previewCanvas: document.getElementById("preview-canvas"),
  previewUploadTrigger: document.getElementById("preview-upload-trigger"),
  statusText: document.getElementById("status-text"),
  photoSize: document.getElementById("photo-size"),
  brushSize: document.getElementById("brush-size"),
  textInput: document.getElementById("text-input"),
  textSize: document.getElementById("text-size"),
  topBlur: document.getElementById("top-blur"),
  topOpacity: document.getElementById("top-opacity"),
  baseBlur: document.getElementById("base-blur"),
  baseOpacity: document.getElementById("base-opacity"),
  rainAOpacity: document.getElementById("rain-a-opacity"),
  rainBOpacity: document.getElementById("rain-b-opacity"),
  useRainA: document.getElementById("use-rain-a"),
  useRainB: document.getElementById("use-rain-b"),
  undoButton: document.getElementById("undo-button"),
  redoButton: document.getElementById("redo-button"),
  clearButton: document.getElementById("clear-button"),
  downloadButton: document.getElementById("download-button"),
  modeButtons: Array.from(document.querySelectorAll("[data-mode]")),
  layerButtons: Array.from(document.querySelectorAll("[data-layer]")),
  modePanels: Array.from(document.querySelectorAll("[data-mode-panel]")),
  layerPanels: Array.from(document.querySelectorAll("[data-layer-panel]")),
};

const outputs = Array.from(document.querySelectorAll("output")).reduce((map, node) => {
  map[node.id] = node;
  return map;
}, {});

const previewContext = controls.previewCanvas.getContext("2d");
const BACKGROUND_COLOR = {
  r: 248,
  g: 244,
  b: 237,
};

function setStatus(message) {
  controls.statusText.textContent = message;
}

function updateOutput(id, value) {
  if (outputs[id]) {
    outputs[id].textContent = value;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load image: ${src}`));
    image.src = src;
  });
}

async function loadImageFromFile(file) {
  if (!file) {
    return null;
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    image._objectUrl = objectUrl;
    return image;
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function revokeImage(image) {
  if (image && image._objectUrl) {
    URL.revokeObjectURL(image._objectUrl);
  }
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToBlob(canvas, type = "image/png", quality) {
  if (typeof canvas.toBlob === "function") {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(new Error("Canvas export failed."));
      }, type, quality);
    });
  }

  return fetch(canvas.toDataURL(type, quality)).then((response) => response.blob());
}

function buildExportFileName() {
  const date = new Date();
  const stamp = [
    date.getFullYear(),
    `${date.getMonth() + 1}`.padStart(2, "0"),
    `${date.getDate()}`.padStart(2, "0"),
  ].join("");

  return `雨窗画写效果图-${stamp}.png`;
}

function isTouchDevice() {
  return (
    navigator.maxTouchPoints > 0 ||
    window.matchMedia("(pointer: coarse)").matches ||
    "ontouchstart" in window
  );
}

async function tryShareImage(blob, fileName) {
  if (typeof navigator.share !== "function" || typeof File !== "function") {
    return "unsupported";
  }

  const file = new File([blob], fileName, {
    type: blob.type || "image/png",
    lastModified: Date.now(),
  });
  const payload = {
    files: [file],
    title: "雨窗画写效果图",
  };

  if (typeof navigator.canShare === "function") {
    try {
      if (!navigator.canShare(payload)) {
        return "unsupported";
      }
    } catch (error) {
      console.error(error);
      return "unsupported";
    }
  }

  try {
    await navigator.share(payload);
    return "shared";
  } catch (error) {
    if (error?.name === "AbortError") {
      return "cancelled";
    }

    console.error(error);
    return "failed";
  }
}

function triggerBlobDownload(blob, fileName) {
  let url = null;

  try {
    url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.target = "_blank";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return true;
  } catch (error) {
    console.error(error);

    if (url) {
      URL.revokeObjectURL(url);
    }

    return false;
  }
}

function openBlobPreview(blob) {
  const url = URL.createObjectURL(blob);
  const previewWindow = window.open(url, "_blank", "noopener");
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return Boolean(previewWindow);
}

function clampChannel(value) {
  return Math.max(0, Math.min(255, value));
}

function buildSolidImageData(width, height, color) {
  const imageData = new ImageData(width, height);

  for (let i = 0; i < imageData.data.length; i += 4) {
    imageData.data[i] = color.r;
    imageData.data[i + 1] = color.g;
    imageData.data[i + 2] = color.b;
    imageData.data[i + 3] = 255;
  }

  return imageData;
}

function drawImageCover(ctx, image, destinationWidth, destinationHeight, trim = 0) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const cropX = sourceWidth * trim;
  const cropY = sourceHeight * trim;
  const croppedWidth = sourceWidth - cropX * 2;
  const croppedHeight = sourceHeight - cropY * 2;
  const sourceAspect = croppedWidth / croppedHeight;
  const destinationAspect = destinationWidth / destinationHeight;

  let sx = cropX;
  let sy = cropY;
  let sw = croppedWidth;
  let sh = croppedHeight;

  if (sourceAspect > destinationAspect) {
    sw = croppedHeight * destinationAspect;
    sx = cropX + (croppedWidth - sw) / 2;
  } else {
    sh = croppedWidth / destinationAspect;
    sy = cropY + (croppedHeight - sh) / 2;
  }

  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, destinationWidth, destinationHeight);
}

function buildBlurredImageData(image, width, height, blurPx) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.filter = `blur(${Number(blurPx)}px)`;
  drawImageCover(ctx, image, width, height);
  ctx.filter = "none";
  return ctx.getImageData(0, 0, width, height);
}

function screenBlend(base, blend) {
  return clampChannel(255 - ((255 - base) * (255 - blend)) / 255);
}

function softLightBlend(base, blend) {
  const baseNorm = base / 255;
  const blendNorm = blend / 255;
  let result = 0;

  if (blendNorm <= 0.5) {
    result = baseNorm - (1 - 2 * blendNorm) * baseNorm * (1 - baseNorm);
  } else {
    const g =
      baseNorm <= 0.25
        ? ((16 * baseNorm - 12) * baseNorm + 4) * baseNorm
        : Math.sqrt(baseNorm);
    result = baseNorm + (2 * blendNorm - 1) * (g - baseNorm);
  }

  return clampChannel(result * 255);
}

function blendNormal(baseData, layerData, opacity) {
  const base = baseData.data;
  const layer = layerData.data;
  const layerOpacity = Math.max(0, Math.min(1, opacity));

  for (let i = 0; i < base.length; i += 4) {
    const alpha = layerOpacity * (layer[i + 3] / 255);
    if (alpha <= 0) {
      continue;
    }

    base[i] = clampChannel(base[i] * (1 - alpha) + layer[i] * alpha);
    base[i + 1] = clampChannel(base[i + 1] * (1 - alpha) + layer[i + 1] * alpha);
    base[i + 2] = clampChannel(base[i + 2] * (1 - alpha) + layer[i + 2] * alpha);
    base[i + 3] = 255;
  }
}

function applyMaskedReveal(baseData, revealData, maskData) {
  const base = baseData.data;
  const reveal = revealData.data;
  const mask = maskData.data;

  for (let i = 0; i < base.length; i += 4) {
    const alpha = mask[i + 3] / 255;
    if (alpha <= 0) {
      continue;
    }

    base[i] = clampChannel(base[i] * (1 - alpha) + reveal[i] * alpha);
    base[i + 1] = clampChannel(base[i + 1] * (1 - alpha) + reveal[i + 1] * alpha);
    base[i + 2] = clampChannel(base[i + 2] * (1 - alpha) + reveal[i + 2] * alpha);
    base[i + 3] = 255;
  }
}

function blendLayer(baseData, layerData, opacity, mode) {
  const base = baseData.data;
  const blend = layerData.data;
  const layerOpacity = Math.max(0, Math.min(1, opacity));

  for (let i = 0; i < base.length; i += 4) {
    const alpha = layerOpacity * (blend[i + 3] / 255);
    if (alpha <= 0) {
      continue;
    }

    const nextR = mode(base[i], blend[i]);
    const nextG = mode(base[i + 1], blend[i + 1]);
    const nextB = mode(base[i + 2], blend[i + 2]);

    base[i] = clampChannel(base[i] * (1 - alpha) + nextR * alpha);
    base[i + 1] = clampChannel(base[i + 1] * (1 - alpha) + nextG * alpha);
    base[i + 2] = clampChannel(base[i + 2] * (1 - alpha) + nextB * alpha);
    base[i + 3] = 255;
  }
}

function buildTextureData(texture, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  drawImageCover(ctx, texture, width, height, 0.045);
  return ctx.getImageData(0, 0, width, height);
}

function getBrushWidth(size, width, height) {
  return Math.max(2, (Math.min(width, height) * size) / 420);
}

function buildLineMask(width, height) {
  if (!state.line.strokes.length) {
    return null;
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#121212";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  state.line.strokes.forEach((stroke) => {
    if (!stroke.points.length) {
      return;
    }

    ctx.beginPath();
    ctx.lineWidth = getBrushWidth(stroke.size, width, height);
    stroke.points.forEach((point, index) => {
      const x = point.x * width;
      const y = point.y * height;
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  });

  return {
    maskData: ctx.getImageData(0, 0, width, height),
  };
}

function wrapTextByWidth(ctx, text, maxWidth) {
  const paragraphs = text.split("\n");
  const lines = [];

  paragraphs.forEach((paragraph) => {
    if (!paragraph) {
      lines.push("");
      return;
    }

    let current = "";
    Array.from(paragraph).forEach((char) => {
      const attempt = current + char;
      if (current && ctx.measureText(attempt).width > maxWidth) {
        lines.push(current);
        current = char;
      } else {
        current = attempt;
      }
    });

    if (current) {
      lines.push(current);
    }
  });

  return lines.length ? lines : [""];
}

function getTextLayout(width, height) {
  const value = state.text.value.trim();
  if (!value) {
    return null;
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const fontPx = Math.max(20, (Math.min(width, height) * state.text.size) / 520);
  ctx.font =
    `700 ${fontPx}px "Microsoft YaHei UI", "Microsoft YaHei", "微软雅黑", sans-serif`;
  const maxWidth = width * 0.72;
  const lines = wrapTextByWidth(ctx, value, maxWidth);
  const measuredWidth = lines.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0);
  const lineHeight = fontPx * 1.22;
  const boxWidth = Math.max(measuredWidth, fontPx);
  const boxHeight = lineHeight * lines.length;
  const centerX = width * (0.5 + state.text.offsetX * 0.5);
  const centerY = height * (0.5 + state.text.offsetY * 0.5);
  const x = centerX - boxWidth / 2;
  const y = centerY - boxHeight / 2;

  return {
    lines,
    fontPx,
    lineHeight,
    x,
    y,
    boxWidth,
    boxHeight,
  };
}

function buildTextMask(width, height) {
  const layout = getTextLayout(width, height);
  if (!layout) {
    return null;
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#121212";
  ctx.font =
    `700 ${layout.fontPx}px "Microsoft YaHei UI", "Microsoft YaHei", "微软雅黑", sans-serif`;
  ctx.textBaseline = "top";

  layout.lines.forEach((line, index) => {
    ctx.fillText(line, layout.x, layout.y + index * layout.lineHeight);
  });

  return {
    maskData: ctx.getImageData(0, 0, width, height),
    placement: {
      x: layout.x,
      y: layout.y,
      drawWidth: layout.boxWidth,
      drawHeight: layout.boxHeight,
    },
  };
}

function hasTransparency(image) {
  const sampleWidth = 160;
  const sampleHeight = Math.max(1, Math.round((sampleWidth / image.width) * image.height));
  const canvas = createCanvas(sampleWidth, sampleHeight);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, sampleWidth, sampleHeight);
  const data = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;

  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) {
      return true;
    }
  }

  return false;
}

function getPhotoPlacement(width, height) {
  if (!state.photoOverlayImage) {
    return null;
  }

  const imageWidth = state.photoOverlayImage.naturalWidth || state.photoOverlayImage.width;
  const imageHeight = state.photoOverlayImage.naturalHeight || state.photoOverlayImage.height;
  const scaleBase = Math.min(width / imageWidth, height / imageHeight);
  const scale = scaleBase * (state.photo.size / 100);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  const centerX = width * (0.5 + state.photo.offsetX * 0.5);
  const centerY = height * (0.5 + state.photo.offsetY * 0.5);

  return {
    x: centerX - drawWidth / 2,
    y: centerY - drawHeight / 2,
    drawWidth,
    drawHeight,
  };
}

function buildPhotoMask(width, height) {
  const placement = getPhotoPlacement(width, height);
  if (!placement) {
    return null;
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(
    state.photoOverlayImage,
    placement.x,
    placement.y,
    placement.drawWidth,
    placement.drawHeight,
  );

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const useAlpha = hasTransparency(state.photoOverlayImage);
  const threshold = 232;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const alpha = data[i + 3] / 255;

    let maskAlpha = 0;
    if (useAlpha) {
      maskAlpha = alpha;
    } else {
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      maskAlpha = alpha * Math.max(0, (threshold - luma) / threshold);
    }

    const value = Math.round(Math.max(0, Math.min(1, maskAlpha)) * 255);
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = value;
  }

  return {
    maskData: imageData,
    placement,
  };
}

function buildActiveMask(width, height) {
  if (state.activeMode === "photo") {
    return buildPhotoMask(width, height);
  }
  if (state.activeMode === "brush") {
    return buildLineMask(width, height);
  }
  if (state.activeMode === "text") {
    return buildTextMask(width, height);
  }
  return null;
}

function drawGuide(ctx, width, placement) {
  if (!placement) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = "rgba(31, 26, 21, 0.78)";
  ctx.lineWidth = Math.max(1.5, width * 0.0022);
  ctx.setLineDash([width * 0.012, width * 0.008]);
  ctx.strokeRect(placement.x, placement.y, placement.drawWidth, placement.drawHeight);
  ctx.restore();
}

function renderPlaceholder() {
  const width = controls.previewCanvas.width;
  const height = controls.previewCanvas.height;
  previewContext.clearRect(0, 0, width, height);
  previewContext.fillStyle = "#f8f4ed";
  previewContext.fillRect(0, 0, width, height);
}

function resizePreviewCanvas() {
  const frame = controls.previewCanvas.parentElement;
  const cssWidth = Math.max(260, Math.floor(frame.clientWidth));
  const cssHeight = Math.round((cssWidth * 4) / 3);
  const dpr = window.devicePixelRatio || 1;

  controls.previewCanvas.width = Math.max(1, Math.round(cssWidth * dpr));
  controls.previewCanvas.height = Math.max(1, Math.round(cssHeight * dpr));
  controls.previewCanvas.style.width = `${cssWidth}px`;
  controls.previewCanvas.style.height = `${cssHeight}px`;
}

function composeToCanvas(targetCanvas, includeGuide = false) {
  const width = targetCanvas.width;
  const height = targetCanvas.height;
  const ctx = targetCanvas.getContext("2d");

  if (!state.baseImage) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#f8f4ed";
    ctx.fillRect(0, 0, width, height);
    return;
  }

  const bottomData = buildBlurredImageData(state.baseImage, width, height, controls.baseBlur.value);
  const topData = buildBlurredImageData(state.baseImage, width, height, controls.topBlur.value);
  const composition = buildSolidImageData(width, height, BACKGROUND_COLOR);
  const baseOpacity = Number(controls.baseOpacity.value) / 100;
  const topOpacity = Number(controls.topOpacity.value) / 100;

  blendNormal(composition, bottomData, baseOpacity);

  if (controls.useRainA.checked && state.rainAImage) {
    const rainAData = buildTextureData(state.rainAImage, width, height);
    blendLayer(composition, rainAData, Number(controls.rainAOpacity.value) / 100, softLightBlend);
  }

  if (controls.useRainB.checked && state.rainBImage) {
    const rainBData = buildTextureData(state.rainBImage, width, height);
    blendLayer(composition, rainBData, Number(controls.rainBOpacity.value) / 100, screenBlend);
  }

  const activeMask = buildActiveMask(width, height);
  if (activeMask?.maskData) {
    const revealComposition = buildSolidImageData(width, height, BACKGROUND_COLOR);
    blendNormal(revealComposition, bottomData, baseOpacity);
    blendNormal(revealComposition, topData, topOpacity);
    applyMaskedReveal(composition, revealComposition, activeMask.maskData);
  }

  ctx.putImageData(composition, 0, 0);

  if (includeGuide && state.activeMode !== "brush" && activeMask?.placement) {
    drawGuide(ctx, width, activeMask.placement);
  }
}

function renderPreview() {
  resizePreviewCanvas();

  if (!state.baseImage) {
    renderPlaceholder();
    return;
  }

  composeToCanvas(controls.previewCanvas, true);
}

function scheduleRender() {
  const token = ++state.renderToken;
  requestAnimationFrame(() => {
    if (token !== state.renderToken) {
      return;
    }
    renderPreview();
  });
}

function updateBackgroundTrigger() {
  controls.previewUploadTrigger.hidden = Boolean(state.baseImage);
}

function updateUndoRedoState() {
  const brushMode = state.activeMode === "brush";
  controls.undoButton.disabled = !brushMode || !state.line.strokes.length;
  controls.redoButton.disabled = !brushMode || !state.line.redo.length;
}

function updateModeUI() {
  controls.modeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === state.activeMode);
  });

  controls.modePanels.forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.modePanel === state.activeMode);
  });

  updateUndoRedoState();
}

function updateLayerUI() {
  controls.layerButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.layer === state.activeLayer);
  });

  controls.layerPanels.forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.layerPanel === state.activeLayer);
  });
}

function updateLayerOutputs() {
  updateOutput("photo-size-value", `${controls.photoSize.value}%`);
  updateOutput("brush-size-value", `${controls.brushSize.value}px`);
  updateOutput("text-size-value", `${controls.textSize.value}px`);
  updateOutput("top-blur-value", `${controls.topBlur.value}px`);
  updateOutput("top-opacity-value", `${controls.topOpacity.value}%`);
  updateOutput("base-blur-value", `${controls.baseBlur.value}px`);
  updateOutput("base-opacity-value", `${controls.baseOpacity.value}%`);
  updateOutput("rain-a-opacity-value", `${controls.rainAOpacity.value}%`);
  updateOutput("rain-b-opacity-value", `${controls.rainBOpacity.value}%`);
}

function setMode(mode) {
  state.activeMode = mode;
  updateModeUI();
  scheduleRender();
}

function setLayer(layer) {
  state.activeLayer = layer;
  updateLayerUI();
}

function getCanvasPoint(event) {
  const rect = controls.previewCanvas.getBoundingClientRect();
  const scaleX = controls.previewCanvas.width / rect.width;
  const scaleY = controls.previewCanvas.height / rect.height;

  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
    width: controls.previewCanvas.width,
    height: controls.previewCanvas.height,
  };
}

function isPointInPlacement(point, placement) {
  if (!placement) {
    return false;
  }

  return (
    point.x >= placement.x &&
    point.x <= placement.x + placement.drawWidth &&
    point.y >= placement.y &&
    point.y <= placement.y + placement.drawHeight
  );
}

function startDrawing(point) {
  state.interaction = {
    type: "draw",
    stroke: {
      size: state.line.size,
      points: [
        {
          x: point.x / point.width,
          y: point.y / point.height,
        },
      ],
    },
  };
  setStatus("正在绘制。");
}

function startDragging(point, offsetX, offsetY) {
  state.interaction = {
    type: "drag-text",
    startX: point.x,
    startY: point.y,
    offsetX,
    offsetY,
    width: point.width,
    height: point.height,
  };
  setStatus("正在移动文字。");
}

function handlePointerDown(event) {
  if (!state.baseImage) {
    return;
  }

  const point = getCanvasPoint(event);

  if (state.activeMode === "brush") {
    controls.previewCanvas.setPointerCapture(event.pointerId);
    startDrawing(point);
    return;
  }

  if (state.activeMode === "photo" && state.photoOverlayImage) {
    const photoMask = buildPhotoMask(point.width, point.height);
    if (photoMask?.placement && isPointInPlacement(point, photoMask.placement)) {
      controls.previewCanvas.setPointerCapture(event.pointerId);
      state.interaction = {
        type: "drag-photo",
        startX: point.x,
        startY: point.y,
        offsetX: state.photo.offsetX,
        offsetY: state.photo.offsetY,
        width: point.width,
        height: point.height,
      };
      setStatus("正在移动素材图。");
    }
    return;
  }

  if (state.activeMode === "text" && state.text.value.trim()) {
    const textMask = buildTextMask(point.width, point.height);
    if (textMask?.placement && isPointInPlacement(point, textMask.placement)) {
      controls.previewCanvas.setPointerCapture(event.pointerId);
      startDragging(point, state.text.offsetX, state.text.offsetY);
    }
  }
}

function handlePointerMove(event) {
  if (!state.interaction) {
    return;
  }

  const point = getCanvasPoint(event);

  if (state.interaction.type === "draw") {
    state.interaction.stroke.points.push({
      x: point.x / point.width,
      y: point.y / point.height,
    });
    scheduleRender();
    return;
  }

  const deltaX = (point.x - state.interaction.startX) / state.interaction.width;
  const deltaY = (point.y - state.interaction.startY) / state.interaction.height;

  if (state.interaction.type === "drag-photo") {
    state.photo.offsetX = Math.max(-0.45, Math.min(0.45, state.interaction.offsetX + deltaX * 2));
    state.photo.offsetY = Math.max(-0.45, Math.min(0.45, state.interaction.offsetY + deltaY * 2));
  } else {
    state.text.offsetX = Math.max(-0.45, Math.min(0.45, state.interaction.offsetX + deltaX * 2));
    state.text.offsetY = Math.max(-0.45, Math.min(0.45, state.interaction.offsetY + deltaY * 2));
  }

  scheduleRender();
}

function finishInteraction() {
  if (!state.interaction) {
    return;
  }

  if (state.interaction.type === "draw" && state.interaction.stroke.points.length) {
    state.line.strokes.push(state.interaction.stroke);
    state.line.redo = [];
    setStatus("画笔已保存。");
  } else if (state.interaction.type === "drag-photo") {
    setStatus("素材图位置已更新。");
  } else if (state.interaction.type === "drag-text") {
    setStatus("文字位置已更新。");
  }

  state.interaction = null;
  updateUndoRedoState();
  scheduleRender();
}

function clearCurrentMode() {
  if (state.activeMode === "photo") {
    revokeImage(state.photoOverlayImage);
    state.photoOverlayImage = null;
    state.photo.size = 50;
    state.photo.offsetX = 0;
    state.photo.offsetY = 0;
    controls.overlayInput.value = "";
    controls.photoSize.value = "50";
    updateLayerOutputs();
    setStatus("素材图已清空。");
    scheduleRender();
    return;
  }

  if (state.activeMode === "brush") {
    state.line.strokes = [];
    state.line.redo = [];
    setStatus("画笔内容已清空。");
    updateUndoRedoState();
    scheduleRender();
    return;
  }

  state.text.value = "";
  state.text.size = 48;
  state.text.offsetX = 0;
  state.text.offsetY = 0;
  controls.textInput.value = "";
  controls.textSize.value = "48";
  updateLayerOutputs();
  setStatus("文字已清空。");
  scheduleRender();
}

async function handleBaseChange(event) {
  const [file] = event.target.files;
  if (!file) {
    return;
  }

  setStatus("正在载入背景图。");
  revokeImage(state.baseImage);
  state.baseImage = await loadImageFromFile(file);
  updateBackgroundTrigger();
  setStatus("背景图已就绪。");
  scheduleRender();
}

async function handlePhotoOverlayChange(event) {
  const [file] = event.target.files;
  if (!file) {
    return;
  }

  setStatus("正在载入素材图。");
  revokeImage(state.photoOverlayImage);
  state.photoOverlayImage = await loadImageFromFile(file);
  state.photo.offsetX = 0;
  state.photo.offsetY = 0;
  setStatus("素材图已就绪。");
  scheduleRender();
}

function handlePhotoSize() {
  state.photo.size = Number(controls.photoSize.value);
  updateOutput("photo-size-value", `${state.photo.size}%`);
  scheduleRender();
}

function handleBrushSize() {
  state.line.size = Number(controls.brushSize.value);
  updateOutput("brush-size-value", `${state.line.size}px`);
}

function handleTextInput() {
  state.text.value = controls.textInput.value;
  setStatus(state.text.value.trim() ? "文字已更新。" : "文字已清空。");
  scheduleRender();
}

function handleTextSize() {
  state.text.size = Number(controls.textSize.value);
  updateOutput("text-size-value", `${state.text.size}px`);
  scheduleRender();
}

function undoLine() {
  if (state.activeMode !== "brush" || !state.line.strokes.length) {
    return;
  }

  const stroke = state.line.strokes.pop();
  state.line.redo.push(stroke);
  updateUndoRedoState();
  setStatus("已撤销一笔。");
  scheduleRender();
}

function redoLine() {
  if (state.activeMode !== "brush" || !state.line.redo.length) {
    return;
  }

  const stroke = state.line.redo.pop();
  state.line.strokes.push(stroke);
  updateUndoRedoState();
  setStatus("已恢复一笔。");
  scheduleRender();
}

async function downloadResult() {
  if (!state.baseImage) {
    setStatus("请先上传背景图。");
    return;
  }

  try {
    setStatus("正在生成导出图。");
    const exportCanvas = createCanvas(1500, 2000);
    composeToCanvas(exportCanvas, false);

    const blob = await canvasToBlob(exportCanvas, "image/png");
    const fileName = buildExportFileName();
    const shareResult = await tryShareImage(blob, fileName);

    if (shareResult === "shared") {
      setStatus("已打开系统保存面板。");
      return;
    }

    if (shareResult === "cancelled") {
      setStatus("已取消保存。");
      return;
    }

    const downloaded = triggerBlobDownload(blob, fileName);
    if (downloaded) {
      setStatus(
        isTouchDevice()
          ? "图片已生成。如未自动保存，请在新打开的图片页长按保存。"
          : "PNG 已导出。",
      );
      return;
    }

    const opened = openBlobPreview(blob);
    setStatus(opened ? "已打开图片，请长按或另存为。" : "导出失败，请重试。");
  } catch (error) {
    console.error(error);
    setStatus("导出失败，请重试。");
  }
}

function bindInputs() {
  const triggerBackgroundUpload = () => {
    controls.baseInput.click();
  };

  controls.baseInput.addEventListener("change", (event) => {
    handleBaseChange(event).catch((error) => {
      console.error(error);
      setStatus("背景图载入失败。");
    });
  });

  controls.previewUploadTrigger.addEventListener("click", triggerBackgroundUpload);
  const replaceBackgroundButton = document.getElementById("replace-background-button");
  replaceBackgroundButton?.addEventListener("click", triggerBackgroundUpload);

  controls.overlayInput.addEventListener("change", (event) => {
    handlePhotoOverlayChange(event).catch((error) => {
      console.error(error);
      setStatus("素材图载入失败。");
    });
  });

  controls.overlayUploadButton.addEventListener("click", () => {
    controls.overlayInput.click();
  });

  controls.photoSize.addEventListener("input", handlePhotoSize);
  controls.brushSize.addEventListener("input", () => {
    handleBrushSize();
  });

  controls.textInput.addEventListener("input", handleTextInput);
  controls.textSize.addEventListener("input", handleTextSize);

  [
    controls.topBlur,
    controls.topOpacity,
    controls.baseBlur,
    controls.baseOpacity,
    controls.rainAOpacity,
    controls.rainBOpacity,
    controls.useRainA,
    controls.useRainB,
  ].forEach((node) => {
    node.addEventListener("input", () => {
      updateLayerOutputs();
      scheduleRender();
    });
  });

  controls.modeButtons.forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });

  controls.layerButtons.forEach((button) => {
    button.addEventListener("click", () => setLayer(button.dataset.layer));
  });

  controls.undoButton.addEventListener("click", undoLine);
  controls.redoButton.addEventListener("click", redoLine);
  controls.clearButton.addEventListener("click", clearCurrentMode);
  controls.downloadButton.addEventListener("click", downloadResult);

  controls.previewCanvas.addEventListener("pointerdown", handlePointerDown);
  controls.previewCanvas.addEventListener("pointermove", handlePointerMove);
  controls.previewCanvas.addEventListener("pointerup", finishInteraction);
  controls.previewCanvas.addEventListener("pointercancel", finishInteraction);
  controls.previewCanvas.addEventListener("pointerleave", finishInteraction);

  window.addEventListener("resize", scheduleRender);
}

async function bootstrap() {
  bindInputs();
  updateLayerOutputs();
  updateBackgroundTrigger();
  updateModeUI();
  updateLayerUI();

  try {
    [state.rainAImage, state.rainBImage] = await Promise.all([
      loadImage("./assets/raindrops-a.jpg"),
      loadImage("./assets/raindrops-b.jpg"),
    ]);
  } catch (error) {
    console.error(error);
    setStatus("雨滴素材加载失败。");
  }

  renderPreview();
}

bootstrap();
