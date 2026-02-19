/**
 * 客户端按钮颜色检测 — 通过像素采样检测 WePoker 操作按钮
 *
 * WePoker 界面实测布局：
 *   y: 0-70%    牌桌区域
 *   y: 72-78%   底池比例按钮行（灰色）
 *   y: 78-86%   ★ 操作按钮行 ★
 *                x: 12-28%  红色"弃牌"（圆形）
 *                x: 32-52%  蓝色"加注"
 *                x: 58-78%  蓝色"跟注"
 *   y: 87-94%   手牌区域（红色花色会误触发！）
 *   y: 95-100%  系统工具栏
 *
 * 关键判定：在按钮行区域检测红色弃牌按钮聚集 + 蓝色跟注/加注按钮辅证
 */

/** 操作按钮行扫描区域（精确覆盖，排除手牌和工具栏） */
const BUTTON_REGION = {
  yStartRatio: 0.76,  // 按钮行顶部（留余量）
  yEndRatio: 0.88,    // 按钮行底部（不含手牌区）
  xStartRatio: 0.05,  // 左边距
  xEndRatio: 0.80,    // 排除右下角盾牌图标
};

/** 弃牌按钮子区域（仅用于红色聚集检测） */
const FOLD_REGION = {
  xStartRatio: 0.05,
  xEndRatio: 0.35,
};

/** 蓝色按钮子区域（跟注/加注） */
const BLUE_REGION = {
  xStartRatio: 0.30,
  xEndRatio: 0.80,
};

/** 像素采样步长 */
const SAMPLE_STEP = 4;

/** 红色像素整体占比阈值 */
const RED_THRESHOLD = 0.006;

/** 蓝色像素占比阈值 */
const BLUE_THRESHOLD = 0.008;

/** 聚集检测：网格中单格最低红色密度 */
const GRID_DENSITY_THRESHOLD = 0.03;

/** 聚集检测网格大小 */
const GRID_COLS = 4;
const GRID_ROWS = 3;

/** 按钮检测结果 */
export interface ButtonDetectionResult {
  hasRedButton: boolean;    // 检测到红色按钮聚集
  hasBlueButton: boolean;   // 检测到蓝色按钮（辅证）
  redDensity: number;       // 红色像素密度
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

const DEFAULT_RESULT: ButtonDetectionResult = {
  hasRedButton: false,
  hasBlueButton: false,
  redDensity: 0,
  confidence: 'LOW',
};

/**
 * 检测 canvas 中是否存在 WePoker 操作按钮
 * 返回丰富的检测结果，包含红色/蓝色按钮状态和置信度
 */
export function detectActionButtons(canvas: HTMLCanvasElement): ButtonDetectionResult {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ...DEFAULT_RESULT };

  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return { ...DEFAULT_RESULT };

  // 整体扫描区域
  const regionStartX = Math.floor(w * BUTTON_REGION.xStartRatio);
  const regionStartY = Math.floor(h * BUTTON_REGION.yStartRatio);
  const regionEndX = Math.floor(w * BUTTON_REGION.xEndRatio);
  const regionEndY = Math.floor(h * BUTTON_REGION.yEndRatio);
  const regionW = regionEndX - regionStartX;
  const regionH = regionEndY - regionStartY;

  if (regionW <= 0 || regionH <= 0) return { ...DEFAULT_RESULT };

  const imageData = ctx.getImageData(regionStartX, regionStartY, regionW, regionH);
  const data = imageData.data;

  // ── 弃牌子区域坐标（相对于 imageData） ──
  const foldStartX = Math.floor(w * FOLD_REGION.xStartRatio) - regionStartX;
  const foldEndX = Math.floor(w * FOLD_REGION.xEndRatio) - regionStartX;

  // ── 蓝色子区域坐标（相对于 imageData） ──
  const blueStartX = Math.floor(w * BLUE_REGION.xStartRatio) - regionStartX;
  const blueEndX = Math.floor(w * BLUE_REGION.xEndRatio) - regionStartX;

  // ── 网格聚集检测：把弃牌子区域分成 GRID_COLS x GRID_ROWS 格子 ──
  const foldW = Math.max(foldEndX - foldStartX, 1);
  const cellW = Math.floor(foldW / GRID_COLS);
  const cellH = Math.floor(regionH / GRID_ROWS);
  // 每个格子的红色采样计数
  const gridRed: number[][] = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(0));
  const gridTotal: number[][] = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(0));

  let redCount = 0;
  let redSampleCount = 0;
  let blueCount = 0;
  let blueSampleCount = 0;

  // 逐像素采样（按步长）
  for (let y = 0; y < regionH; y += SAMPLE_STEP) {
    for (let x = 0; x < regionW; x += SAMPLE_STEP) {
      const idx = (y * regionW + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      // ── 弃牌子区域：红色检测 + 网格统计 ──
      if (x >= foldStartX && x < foldEndX) {
        redSampleCount++;
        if (isRedPixel(r, g, b)) {
          redCount++;
          // 计入网格
          const col = Math.min(Math.floor((x - foldStartX) / cellW), GRID_COLS - 1);
          const row = Math.min(Math.floor(y / cellH), GRID_ROWS - 1);
          gridRed[row][col]++;
        }
        // 更新网格总计
        const col = Math.min(Math.floor((x - foldStartX) / cellW), GRID_COLS - 1);
        const row = Math.min(Math.floor(y / cellH), GRID_ROWS - 1);
        gridTotal[row][col]++;
      }

      // ── 蓝色子区域：蓝色检测 ──
      if (x >= blueStartX && x < blueEndX) {
        blueSampleCount++;
        if (isBluePixel(r, g, b)) {
          blueCount++;
        }
      }
    }
  }

  // ── 计算结果 ──
  const redDensity = redSampleCount > 0 ? redCount / redSampleCount : 0;
  const blueDensity = blueSampleCount > 0 ? blueCount / blueSampleCount : 0;

  // 红色整体达标
  const hasRedOverall = redDensity > RED_THRESHOLD;

  // 红色聚集检测：检查是否存在 2x2 子网格，每格密度都超过阈值
  const hasRedCluster = checkCluster(gridRed, gridTotal);

  // 蓝色达标
  const hasBlueButton = blueDensity > BLUE_THRESHOLD;

  // 综合判定
  const hasRedButton = hasRedOverall && hasRedCluster;

  let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  if (hasRedButton && hasBlueButton) {
    confidence = 'HIGH';
  } else if (hasRedButton) {
    confidence = 'MEDIUM';
  } else {
    confidence = 'LOW';
  }

  return { hasRedButton, hasBlueButton, redDensity, confidence };
}

/**
 * 检测按钮状态变化（出现/消失）
 */
export function detectButtonTransition(
  prevHadButtons: boolean,
  current: ButtonDetectionResult
): { appeared: boolean; disappeared: boolean; current: boolean } {
  const currentHas = current.hasRedButton;
  return {
    appeared: !prevHadButtons && currentHas,
    disappeared: prevHadButtons && !currentHas,
    current: currentHas,
  };
}

// ── 内部辅助函数 ──

/** 判断是否为红色像素（饱和红色，弃牌按钮） */
function isRedPixel(r: number, g: number, b: number): boolean {
  return r > 170 && g < 100 && b < 100;
}

/** 判断是否为蓝色像素（跟注/加注按钮） */
function isBluePixel(r: number, g: number, b: number): boolean {
  return b > 150 && r < 100 && g < 150 && (b - r) > 60;
}

/**
 * 检查网格中是否存在 2x2 子网格，其中每格红色密度都超过阈值
 * 这确保红色像素是空间聚集的（如按钮），而非分散的（如手牌花色）
 */
function checkCluster(gridRed: number[][], gridTotal: number[][]): boolean {
  for (let row = 0; row < GRID_ROWS - 1; row++) {
    for (let col = 0; col < GRID_COLS - 1; col++) {
      // 检查 2x2 区域
      let allAbove = true;
      for (let dr = 0; dr < 2; dr++) {
        for (let dc = 0; dc < 2; dc++) {
          const total = gridTotal[row + dr][col + dc];
          if (total === 0) { allAbove = false; break; }
          const density = gridRed[row + dr][col + dc] / total;
          if (density < GRID_DENSITY_THRESHOLD) { allAbove = false; break; }
        }
        if (!allAbove) break;
      }
      if (allAbove) return true;
    }
  }
  return false;
}
