/*
  Blow Your Bubble
  HTML + p5.js + MediaPipe FaceMesh

  文件结构：
  index.html
  style.css
  script.js
  bubble_wand.png
*/

// ===============================
// 可调参数区域
// ===============================

const PARAMS = {
  // 嘴巴识别
  mouthOpenThreshold: 0.018,
  mouthRoundRatioMin: 0.26,
  mouthRoundRatioMax: 0.78,
  blowShrinkThreshold: 0.004,

  // 吹泡泡冷却时间，数值越小越容易连续生成
  bubbleSpawnCooldown: 9,

  // 桌面端默认泡泡尺寸
  bubbleSizeMin: 24,
  bubbleSizeMax: 180,

  // 泡泡数量
  bubbleCountMin: 2,
  bubbleCountMax: 6,

  // 背景
  videoAlpha: 245,
  backgroundBlurAlpha: 24,

  // 泡泡棒
  toolImageScale: 0.45,
  toolBottomOverflow: 0.06,

  // 泡泡从工具圆环位置生成时的微调
  bubbleOriginXOffset: 0,
  bubbleOriginYOffset: 0,

  // 提示文字
  instructionTop: 18,

  // 音效
  soundEnabled: true,
  soundVolume: 0.32
};

// ===============================
// 全局变量
// ===============================

let video;
let faceMesh;
let faceResults = null;

let bubbleWand;
let bubbles = [];
let ripples = [];

let lastMouthArea = null;
let cooldown = 0;

let audioCtx = null;
let soundUnlocked = false;

let cameraReady = false;

// MediaPipe 嘴部关键点
// FaceMesh landmark index
const MOUTH = {
  leftCorner: 61,
  rightCorner: 291,
  upperLip: 13,
  lowerLip: 14,
  upperOuter: 0,
  lowerOuter: 17
};

// ===============================
// p5 preload
// ===============================

function preload() {
  bubbleWand = loadImage("./bubble_wand.png");
}

// ===============================
// p5 setup
// ===============================

function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);

  setupCamera();
  setupFaceMesh();

  // 用户第一次点击/触摸时解锁浏览器音频
  window.addEventListener("pointerdown", unlockAudio, { once: true });
  window.addEventListener("touchstart", unlockAudio, { once: true });
  document.addEventListener("click", unlockAudio, { once: true });

  textFont("Helvetica Neue, Arial, sans-serif");
}

// ===============================
// 摄像头设置
// ===============================

function setupCamera() {
  video = createCapture(
    {
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    },
    () => {
      cameraReady = true;
      const loading = document.getElementById("loading");
      if (loading) loading.style.display = "none";
    }
  );

  video.size(640, 480);
  video.hide();
}

// ===============================
// MediaPipe FaceMesh 设置
// ===============================

function setupFaceMesh() {
  faceMesh = new FaceMesh({
    locateFile: (file) => {
      return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
    }
  });

  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  faceMesh.onResults((results) => {
    faceResults = results;
  });

  const camera = new Camera(video.elt, {
    onFrame: async () => {
      if (video && video.elt && video.elt.readyState >= 2) {
        await faceMesh.send({ image: video.elt });
      }
    },
    width: 640,
    height: 480
  });

  camera.start();
}

// ===============================
// p5 draw
// ===============================

function draw() {
  background(0);

  const rp = getResponsiveParams();

  drawCameraBackground(rp);
  detectBlowAndSpawnBubbles(rp);

  updateAndDrawBubbles();

  drawBubbleWand(rp);
  updateAndDrawRipples();

  drawInstruction(rp);

  if (cooldown > 0) cooldown--;
}

// ===============================
// 响应式参数
// ===============================

function isMobileLike() {
  return width <= 820 || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isPortrait() {
  return height >= width;
}

function getResponsiveParams() {
  const mobile = isMobileLike();
  const portrait = isPortrait();

  // 手机竖屏
  if (mobile && portrait) {
    return {
      ...PARAMS,
      toolImageScale: 0.64,
      toolBottomOverflow: -0.07,
      bubbleSizeMin: 22,
      bubbleSizeMax: 190,
      instructionTop: 14,
      backgroundBlurAlpha: 18,
      videoAlpha: 255,
      bubbleOriginYOffset: -10
    };
  }

  // 手机横屏
  if (mobile && !portrait) {
    return {
      ...PARAMS,
      toolImageScale: 0.52,
      toolBottomOverflow: -0.02,
      bubbleSizeMin: 20,
      bubbleSizeMax: 165,
      instructionTop: 12,
      backgroundBlurAlpha: 20,
      videoAlpha: 255,
      bubbleOriginYOffset: -8
    };
  }

  // 电脑端
  return {
    ...PARAMS,
    toolImageScale: 0.45,
    toolBottomOverflow: 0.06,
    bubbleSizeMin: 24,
    bubbleSizeMax: 205,
    instructionTop: 18,
    backgroundBlurAlpha: 26,
    videoAlpha: 245,
    bubbleOriginYOffset: 0
  };
}

// ===============================
// 摄像头背景绘制
// ===============================

function drawCameraBackground(rp) {
  if (!video || video.width === 0 || video.height === 0) return;

  const r = getCoverVideoRect();

  push();
  tint(255, rp.videoAlpha);

  // 镜像自拍画面
  translate(width, 0);
  scale(-1, 1);

  // 修正镜像后的位置
  image(video, width - r.dx - r.dw, r.dy, r.dw, r.dh);

  pop();

  // 轻微暗色遮罩，让泡泡更明显
  noStroke();
  fill(0, rp.backgroundBlurAlpha);
  rect(0, 0, width, height);
}

// 让摄像头画面 cover 整个屏幕
function getCoverVideoRect() {
  const vw = video.width || 640;
  const vh = video.height || 480;

  const canvasRatio = width / height;
  const videoRatio = vw / vh;

  let dw, dh, dx, dy;

  if (videoRatio > canvasRatio) {
    dh = height;
    dw = dh * videoRatio;
    dx = (width - dw) / 2;
    dy = 0;
  } else {
    dw = width;
    dh = dw / videoRatio;
    dx = 0;
    dy = (height - dh) / 2;
  }

  return { dx, dy, dw, dh };
}

// ===============================
// 嘴巴吹气检测
// ===============================

function detectBlowAndSpawnBubbles(rp) {
  if (!faceResults || !faceResults.multiFaceLandmarks || faceResults.multiFaceLandmarks.length === 0) {
    lastMouthArea = null;
    return;
  }

  const landmarks = faceResults.multiFaceLandmarks[0];

  const left = landmarks[MOUTH.leftCorner];
  const right = landmarks[MOUTH.rightCorner];
  const upper = landmarks[MOUTH.upperLip];
  const lower = landmarks[MOUTH.lowerLip];

  if (!left || !right || !upper || !lower) return;

  const mouthWidth = distNorm(left, right);
  const mouthHeight = distNorm(upper, lower);
  const mouthArea = mouthWidth * mouthHeight;

  const roundRatio = mouthHeight / max(mouthWidth, 0.0001);

  const isOpen = mouthHeight > rp.mouthOpenThreshold;
  const isRound =
    roundRatio > rp.mouthRoundRatioMin &&
    roundRatio < rp.mouthRoundRatioMax;

  let isShrinking = false;

  if (lastMouthArea !== null) {
    const shrinkAmount = lastMouthArea - mouthArea;
    isShrinking = shrinkAmount > rp.blowShrinkThreshold;
  }

  lastMouthArea = lerp(lastMouthArea || mouthArea, mouthArea, 0.55);

  if (isOpen && isRound && isShrinking && cooldown <= 0) {
    const origin = getBubbleOriginFromWand(rp);

    spawnBubbles(origin.x, origin.y, rp);
    ripples.push(new Ripple(origin.x, origin.y));

    playPopSound();

    cooldown = rp.bubbleSpawnCooldown;
  }
}

function distNorm(a, b) {
  return dist(a.x, a.y, b.x, b.y);
}

// ===============================
// 泡泡生成位置：泡泡棒圆环附近
// ===============================

function getBubbleOriginFromWand(rp) {
  const toolH = height * rp.toolImageScale;
  const toolW = toolH * (bubbleWand.width / bubbleWand.height);

  const x = width / 2 + rp.bubbleOriginXOffset;

  // 这个 y 值控制泡泡从泡泡棒大圆环附近出现
  // 不同图片圆环位置不同，可以重点调这里
  const toolBottom = height + toolH * rp.toolBottomOverflow;
  const toolTop = toolBottom - toolH;

  const y = toolTop + toolH * 0.14 + rp.bubbleOriginYOffset;

  return { x, y };
}

// ===============================
// 生成泡泡：一次 2–5 个，不同大小
// ===============================

function spawnBubbles(originX, originY, rp) {
  const count = floor(random(rp.bubbleCountMin, rp.bubbleCountMax + 1));

  for (let i = 0; i < count; i++) {
    const size = getRandomBubbleSize(rp);

    const offsetX = random(-34, 34);
    const offsetY = random(-24, 18);

    const b = new Bubble(
      originX + offsetX,
      originY + offsetY,
      size
    );

    bubbles.push(b);
  }
}

// 小泡泡更多，大泡泡偶尔出现
function getRandomBubbleSize(rp) {
  const t = random();

  if (t < 0.56) {
    return random(rp.bubbleSizeMin, rp.bubbleSizeMin + 42);
  } else if (t < 0.88) {
    return random(rp.bubbleSizeMin + 46, rp.bubbleSizeMax * 0.65);
  } else {
    return random(rp.bubbleSizeMax * 0.7, rp.bubbleSizeMax);
  }
}

// ===============================
// 泡泡类
// ===============================

class Bubble {
  constructor(x, y, size) {
    this.x = x;
    this.y = y;

    this.baseSize = size;
    this.size = size;

    // 快速上飘：小泡泡更快，大泡泡稍慢，但整体速度明显加快
    const speedFactor = map(size, 20, 210, 1.35, 0.78, true);
    this.vy = random(-8.0, -14.0) * speedFactor;

    // 轻微向上的加速度，让泡泡离开嘴巴后越来越快
    this.ay = random(-0.015, -0.04);

    // 左右漂移
    this.vx = random(-1.3, 1.3);

    this.age = 0;
    this.maxLife = random(70, 125);

    this.life = 255;

    this.swingAmp = random(0.7, 2.8);
    this.swingSpeed = random(0.025, 0.065);
    this.phase = random(TWO_PI);

    this.rotation = random(TWO_PI);
    this.rotationSpeed = random(-0.018, 0.018);

    // 弹出动画
    this.popScale = 0.15;

    // 从实时视频里截取一块画面作为泡泡内容
    this.capture = null;
    this.captureVideoPatch();
  }

  captureVideoPatch() {
    if (!video || video.width === 0 || video.height === 0) return;

    // 截取视频中心偏上的区域，比较容易包含人脸和上半身
    const patchSize = min(video.width, video.height) * random(0.42, 0.72);

    const sx = video.width / 2 - patchSize / 2 + random(-60, 60);
    const sy = video.height * random(0.18, 0.36);

    this.capture = video.get(
      constrain(sx, 0, video.width - patchSize),
      constrain(sy, 0, video.height - patchSize),
      patchSize,
      patchSize
    );
  }

  update() {
    this.age++;

    // 更快地往上漂，并带一点上冲感
    this.vy += this.ay;
    this.y += this.vy;

    // 左右轻微摆动
    this.x += this.vx + sin(this.age * this.swingSpeed + this.phase) * this.swingAmp;

    // 轻微旋转
    this.rotation += this.rotationSpeed;

    // 弹出动画：从小到大
    this.popScale = min(1, this.popScale + 0.095);

    // 呼吸感
    this.size =
      this.baseSize *
      this.popScale *
      (1 + sin(this.age * 0.06 + this.phase) * 0.045);

    // 逐渐消失
    this.life = map(this.age, 0, this.maxLife, 255, 0, true);
  }

  draw() {
    push();

    translate(this.x, this.y);
    rotate(this.rotation);

    const alpha = this.life;
    const s = this.size;

    // 泡泡内部的人像纹理
    if (this.capture) {
      push();
      drawingContext.save();

      // 圆形裁切
      drawingContext.beginPath();
      drawingContext.arc(0, 0, s / 2, 0, Math.PI * 2);
      drawingContext.clip();

      // 类似鱼眼感：内部图像稍微放大
      tint(255, alpha * 0.72);
      imageMode(CENTER);
      image(this.capture, 0, 0, s * 1.22, s * 1.22);

      // 加一点乳白透明膜
      noStroke();
      fill(255, alpha * 0.08);
      ellipse(0, 0, s, s);

      drawingContext.restore();
      pop();
    }

    // 泡泡玻璃边缘
    noFill();
    strokeWeight(max(1, s * 0.025));
    stroke(255, alpha * 0.62);
    ellipse(0, 0, s, s);

    // 彩虹薄膜边缘：用几层不同透明描边模拟
    strokeWeight(max(1, s * 0.012));
    stroke(255, 180, 220, alpha * 0.35);
    ellipse(0, 0, s * 0.96, s * 0.96);

    stroke(160, 220, 255, alpha * 0.32);
    ellipse(0, 0, s * 0.9, s * 0.9);

    stroke(255, 245, 160, alpha * 0.24);
    ellipse(0, 0, s * 0.84, s * 0.84);

    // 主要高光
    noStroke();
    fill(255, alpha * 0.68);
    ellipse(-s * 0.18, -s * 0.22, s * 0.18, s * 0.08);

    fill(255, alpha * 0.38);
    ellipse(s * 0.18, s * 0.12, s * 0.08, s * 0.04);

    // 外围淡淡光晕
    noFill();
    stroke(255, alpha * 0.16);
    strokeWeight(max(1, s * 0.04));
    ellipse(0, 0, s * 1.04, s * 1.04);

    pop();
  }

  isDead() {
    return this.life <= 0 || this.y < -this.size * 2;
  }
}

// ===============================
// 更新与绘制泡泡
// ===============================

function updateAndDrawBubbles() {
  for (let i = bubbles.length - 1; i >= 0; i--) {
    bubbles[i].update();
    bubbles[i].draw();

    if (bubbles[i].isDead()) {
      bubbles.splice(i, 1);
    }
  }
}

// ===============================
// 泡泡棒绘制
// ===============================

function drawBubbleWand(rp) {
  if (!bubbleWand) return;

  const toolH = height * rp.toolImageScale;
  const toolW = toolH * (bubbleWand.width / bubbleWand.height);

  const x = width / 2;
  const toolBottom = height + toolH * rp.toolBottomOverflow;
  const y = toolBottom - toolH / 2;

  push();
  imageMode(CENTER);

  // 检测到吹气时，泡泡棒轻微放大
  const pulse = cooldown > rp.bubbleSpawnCooldown - 5 ? 1.035 : 1;

  image(bubbleWand, x, y, toolW * pulse, toolH * pulse);
  pop();
}

// ===============================
// 扩散波纹
// ===============================

class Ripple {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.r = 8;
    this.alpha = 180;
    this.life = 0;
  }

  update() {
    this.life++;
    this.r += 5.2;
    this.alpha *= 0.88;
  }

  draw() {
    push();
    noFill();
    stroke(255, this.alpha);
    strokeWeight(2);
    ellipse(this.x, this.y, this.r, this.r);

    stroke(180, 220, 255, this.alpha * 0.45);
    ellipse(this.x, this.y, this.r * 1.35, this.r * 1.35);
    pop();
  }

  isDead() {
    return this.alpha < 3;
  }
}

function updateAndDrawRipples() {
  for (let i = ripples.length - 1; i >= 0; i--) {
    ripples[i].update();
    ripples[i].draw();

    if (ripples[i].isDead()) {
      ripples.splice(i, 1);
    }
  }
}

// ===============================
// 提示文字
// ===============================

function drawInstruction(rp) {
  push();

  const boxW = min(width * 0.88, 520);
  const boxH = isMobileLike() ? 58 : 62;
  const x = width / 2;
  const y = rp.instructionTop + boxH / 2;

  rectMode(CENTER);
  noStroke();
  fill(255, 210);
  rect(x, y, boxW, boxH, 18);

  fill(0, 220);
  textAlign(CENTER, CENTER);

  textSize(isMobileLike() ? 15 : 17);
  text("张圆嘴巴，用力吹出你的泡泡", x, y - 10);

  textSize(isMobileLike() ? 11 : 12);
  fill(0, 150);
  text("Make an O with your mouth and blow", x, y + 13);

  pop();
}

// ===============================
// 音效：Web Audio API
// 不需要额外音频文件
// ===============================

function unlockAudio() {
  if (!PARAMS.soundEnabled) return;

  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }

  soundUnlocked = true;

  const tapStart = document.getElementById("tapStart");
  if (tapStart) tapStart.style.display = "none";

  // 第一次触摸时播放一个很轻的确认音，确保手机浏览器解锁音频
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  gain.gain.value = PARAMS.soundVolume * 0.45;
  osc.frequency.value = 660;

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start();
  osc.stop(audioCtx.currentTime + 0.055);
}

function playPopSound() {
  if (!PARAMS.soundEnabled) return;

  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }

  // 某些手机浏览器必须用户点击后才允许播放声音
  if (!soundUnlocked && isMobileLike()) {
    return;
  }

  const now = audioCtx.currentTime;

  // 主音：短促 pop
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(random(520, 760), now);
  osc.frequency.exponentialRampToValueAtTime(random(920, 1280), now + 0.045);
  osc.frequency.exponentialRampToValueAtTime(random(380, 520), now + 0.13);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(PARAMS.soundVolume, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start(now);
  osc.stop(now + 0.15);

  // 第二层：轻微泡泡破裂感
  const osc2 = audioCtx.createOscillator();
  const gain2 = audioCtx.createGain();

  osc2.type = "triangle";
  osc2.frequency.setValueAtTime(random(180, 260), now);
  osc2.frequency.exponentialRampToValueAtTime(random(80, 120), now + 0.1);

  gain2.gain.setValueAtTime(0.0001, now);
  gain2.gain.exponentialRampToValueAtTime(PARAMS.soundVolume * 0.45, now + 0.01);
  gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

  osc2.connect(gain2);
  gain2.connect(audioCtx.destination);

  osc2.start(now);
  osc2.stop(now + 0.13);

  // 第三层：非常短的噗声噪音，让弹出感更明显
  const bufferSize = Math.floor(audioCtx.sampleRate * 0.05);
  const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  }

  const noise = audioCtx.createBufferSource();
  const noiseGain = audioCtx.createGain();
  const filter = audioCtx.createBiquadFilter();

  filter.type = "highpass";
  filter.frequency.setValueAtTime(900, now);

  noise.buffer = noiseBuffer;
  noiseGain.gain.setValueAtTime(PARAMS.soundVolume * 0.75, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);

  noise.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(audioCtx.destination);

  noise.start(now);
  noise.stop(now + 0.052);

}

// ===============================
// 窗口尺寸变化
// ===============================

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
