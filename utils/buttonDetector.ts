/**
 * 客户端按钮颜色检测 — 通过像素采样检测 WePoker 操作按钮
 *
 * WePoker 轮到你时，底部会出现明亮的操作按钮：
 * - 弃牌：红色按钮（必定存在）
 * - 跟注/下注/加注：蓝色按钮
 * - 让牌：绿色按钮
 *
 * 不轮到你时，底部只有灰色预操作按钮（"让或弃"、"自动让牌"）和其他图标。
 * 关键判定：必须检测到红色（弃牌按钮）才算轮到我，避免绿色盾牌等图标误判。
 */

/** 按钮区域配置 */
const BUTTON_REGION = {
  /** 从底部算起的高度比例（WePoker 按钮在底部约 10-15%） */
  bottomRatio: 0.15,
  /** 只看左侧 70%（排除右下角图标区域） */
  leftRatio: 0.7,
};

/** 像素采样步长 */
const SAMPLE_STEP = 8;

/** 红色像素占比阈值：弃牌圆形按钮~1.5-2.5%，手牌红心~0.2-0.3% */
const RED_THRESHOLD = 0.008;

/**
 * 检测 canvas 中是否存在 WePoker 操作按钮
 * 核心逻辑：必须检测到红色弃牌按钮（轮到你时一定有）
 */
export function detectActionButtons(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return false;

  // 扫描区域：底部 15%，左侧 70%（排除右下角图标）
  const startX = 0;
  const startY = Math.floor(h * (1 - BUTTON_REGION.bottomRatio));
  const regionW = Math.floor(w * BUTTON_REGION.leftRatio);
  const regionH = h - startY;

  if (regionW <= 0 || regionH <= 0) return false;

  const imageData = ctx.getImageData(startX, startY, regionW, regionH);
  const data = imageData.data;

  let redCount = 0;
  let sampleCount = 0;

  for (let i = 0; i < data.length; i += SAMPLE_STEP * 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    sampleCount++;

    // 红色按钮（弃牌）— 饱和红色
    if (r > 170 && g < 100 && b < 100) {
      redCount++;
    }
  }

  if (sampleCount === 0) return false;

  // 必须检测到红色弃牌按钮才算轮到我
  return (redCount / sampleCount) > RED_THRESHOLD;
}
