/**
 * 计算折扣后价格的工具函数
 * @param price - 原始价格，必须为正数
 * @param rate - 折扣率，取值范围为0到1之间的小数（如0.8表示八折）
 * @returns 折扣后的最终价格，保留两位小数
 * @throws 当价格为负数或折扣率不在有效范围内时抛出错误
 */
function calculateDiscount(price: number, rate: number): number {
  try {
    // 验证价格参数是否合法
    if (price < 0) {
      throw new Error('价格不能为负数');
    }

    // 验证折扣率参数是否在有效范围内
    if (rate < 0 || rate > 1) {
      throw new Error('折扣率必须在0到1之间');
    }

    // 计算折扣后的价格
    const discountedPrice: number = price * rate;

    // 保留两位小数并返回结果
    const finalPrice: number = Math.round(discountedPrice * 100) / 100;
    return finalPrice;
  } catch (error) {
    // 捕获并重新抛出错误，附加上下文信息
    const errorMessage: string = error instanceof Error ? error.message : '未知错误';
    throw new Error(`计算折扣失败: ${errorMessage}`);
  }
}

// 导出函数供外部使用
export { calculateDiscount };
