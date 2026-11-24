/**
 * Pure offline, zero-network reverse geocoder for major cities & travel destinations.
 * Preserves 100% local privacy while enabling location labels and city-name search.
 */

interface CityRecord {
  lat: number;
  lng: number;
  label: string;
  radiusKm?: number;
}

const CITIES: readonly CityRecord[] = [
  // China — Municipalities & Provincial Capitals & Major Cities / Travel Destinations
  { lat: 39.9042, lng: 116.4074, label: '中国 · 北京', radiusKm: 75 },
  { lat: 31.2304, lng: 121.4737, label: '中国 · 上海', radiusKm: 65 },
  { lat: 39.0842, lng: 117.201, label: '中国 · 天津', radiusKm: 60 },
  { lat: 29.563, lng: 106.5516, label: '中国 · 重庆', radiusKm: 85 },
  { lat: 22.3193, lng: 114.1694, label: '中国 · 香港', radiusKm: 35 },
  { lat: 22.1987, lng: 113.5439, label: '中国 · 澳门', radiusKm: 20 },
  { lat: 25.033, lng: 121.5654, label: '中国 · 台北', radiusKm: 45 },
  { lat: 22.6273, lng: 120.3014, label: '中国 · 高雄', radiusKm: 45 },
  { lat: 23.1291, lng: 113.2644, label: '中国 · 广东 · 广州', radiusKm: 55 },
  { lat: 22.5431, lng: 114.0579, label: '中国 · 广东 · 深圳', radiusKm: 45 },
  { lat: 22.2707, lng: 113.5767, label: '中国 · 广东 · 珠海', radiusKm: 40 },
  { lat: 23.0215, lng: 113.1214, label: '中国 · 广东 · 佛山', radiusKm: 40 },
  { lat: 23.0207, lng: 113.7518, label: '中国 · 广东 · 东莞', radiusKm: 35 },
  { lat: 23.3541, lng: 116.682, label: '中国 · 广东 · 汕头', radiusKm: 45 },
  { lat: 30.2741, lng: 120.1551, label: '中国 · 浙江 · 杭州', radiusKm: 65 },
  { lat: 29.8683, lng: 121.544, label: '中国 · 浙江 · 宁波', radiusKm: 55 },
  { lat: 27.9938, lng: 120.6994, label: '中国 · 浙江 · 温州', radiusKm: 55 },
  { lat: 30.7461, lng: 120.7555, label: '中国 · 浙江 · 嘉兴', radiusKm: 40 },
  { lat: 30.0, lng: 120.5853, label: '中国 · 浙江 · 绍兴', radiusKm: 45 },
  { lat: 29.9853, lng: 122.2072, label: '中国 · 浙江 · 舟山', radiusKm: 55 },
  { lat: 32.0603, lng: 118.7969, label: '中国 · 江苏 · 南京', radiusKm: 55 },
  { lat: 31.299, lng: 120.5853, label: '中国 · 江苏 · 苏州', radiusKm: 45 },
  { lat: 31.4912, lng: 120.3119, label: '中国 · 江苏 · 无锡', radiusKm: 40 },
  { lat: 32.3942, lng: 119.4129, label: '中国 · 江苏 · 扬州', radiusKm: 45 },
  { lat: 34.2658, lng: 117.2841, label: '中国 · 江苏 · 徐州', radiusKm: 55 },
  { lat: 30.5728, lng: 104.0668, label: '中国 · 四川 · 成都', radiusKm: 70 },
  { lat: 33.26, lng: 103.9186, label: '中国 · 四川 · 九寨沟', radiusKm: 60 },
  { lat: 30.0509, lng: 101.9625, label: '中国 · 四川 · 康定/川西', radiusKm: 85 },
  { lat: 29.5521, lng: 103.7656, label: '中国 · 四川 · 乐山/峨眉', radiusKm: 55 },
  { lat: 28.454, lng: 100.323, label: '中国 · 四川 · 稻城亚丁', radiusKm: 75 },
  { lat: 30.5928, lng: 114.3055, label: '中国 · 湖北 · 武汉', radiusKm: 65 },
  { lat: 30.692, lng: 111.2865, label: '中国 · 湖北 · 宜昌', radiusKm: 60 },
  { lat: 28.2282, lng: 112.9388, label: '中国 · 湖南 · 长沙', radiusKm: 60 },
  { lat: 29.1171, lng: 110.4792, label: '中国 · 湖南 · 张家界', radiusKm: 65 },
  { lat: 26.0745, lng: 119.2965, label: '中国 · 福建 · 福州', radiusKm: 55 },
  { lat: 24.4798, lng: 118.0894, label: '中国 · 福建 · 厦门', radiusKm: 40 },
  { lat: 24.8741, lng: 118.6757, label: '中国 · 福建 · 泉州', radiusKm: 45 },
  { lat: 34.3416, lng: 108.9398, label: '中国 · 陕西 · 西安', radiusKm: 65 },
  { lat: 36.6512, lng: 117.12, label: '中国 · 山东 · 济南', radiusKm: 55 },
  { lat: 36.0671, lng: 120.3826, label: '中国 · 山东 · 青岛', radiusKm: 60 },
  { lat: 37.4638, lng: 121.4479, label: '中国 · 山东 · 烟台', radiusKm: 55 },
  { lat: 37.5131, lng: 122.1204, label: '中国 · 山东 · 威海', radiusKm: 45 },
  { lat: 34.7466, lng: 113.6253, label: '中国 · 河南 · 郑州', radiusKm: 55 },
  { lat: 34.6197, lng: 112.454, label: '中国 · 河南 · 洛阳', radiusKm: 55 },
  { lat: 31.8206, lng: 117.2272, label: '中国 · 安徽 · 合肥', radiusKm: 55 },
  { lat: 30.1329, lng: 118.165, label: '中国 · 安徽 · 黄山', radiusKm: 65 },
  { lat: 28.6829, lng: 115.8582, label: '中国 · 江西 · 南昌', radiusKm: 55 },
  { lat: 29.2679, lng: 117.1784, label: '中国 · 江西 · 景德镇/婺源', radiusKm: 70 },
  { lat: 25.0389, lng: 102.7183, label: '中国 · 云南 · 昆明', radiusKm: 65 },
  { lat: 25.6065, lng: 100.2676, label: '中国 · 云南 · 大理', radiusKm: 65 },
  { lat: 26.8721, lng: 100.2299, label: '中国 · 云南 · 丽江', radiusKm: 65 },
  { lat: 27.8269, lng: 99.706, label: '中国 · 云南 · 香格里拉', radiusKm: 75 },
  { lat: 22.0088, lng: 100.7972, label: '中国 · 云南 · 西双版纳', radiusKm: 75 },
  { lat: 26.647, lng: 106.6302, label: '中国 · 贵州 · 贵阳', radiusKm: 65 },
  { lat: 22.817, lng: 108.3665, label: '中国 · 广西 · 南宁', radiusKm: 60 },
  { lat: 25.2736, lng: 110.29, label: '中国 · 广西 · 桂林/阳朔', radiusKm: 75 },
  { lat: 21.4811, lng: 109.1199, label: '中国 · 广西 · 北海', radiusKm: 50 },
  { lat: 20.044, lng: 110.1999, label: '中国 · 海南 · 海口', radiusKm: 55 },
  { lat: 18.2528, lng: 109.512, label: '中国 · 海南 · 三亚', radiusKm: 65 },
  { lat: 19.25, lng: 110.47, label: '中国 · 海南 · 万宁/琼海', radiusKm: 65 },
  { lat: 38.0428, lng: 114.5149, label: '中国 · 河北 · 石家庄', radiusKm: 55 },
  { lat: 39.9354, lng: 119.6005, label: '中国 · 河北 · 秦皇岛/阿那亚', radiusKm: 55 },
  { lat: 37.8706, lng: 112.5489, label: '中国 · 山西 · 太原', radiusKm: 55 },
  { lat: 40.0768, lng: 113.3001, label: '中国 · 山西 · 大同', radiusKm: 55 },
  { lat: 41.8057, lng: 123.4315, label: '中国 · 辽宁 · 沈阳', radiusKm: 60 },
  { lat: 38.914, lng: 121.6147, label: '中国 · 辽宁 · 大连', radiusKm: 60 },
  { lat: 43.8171, lng: 125.3235, label: '中国 · 吉林 · 长春', radiusKm: 60 },
  { lat: 42.005, lng: 128.057, label: '中国 · 吉林 · 长白山', radiusKm: 75 },
  { lat: 45.8038, lng: 126.535, label: '中国 · 黑龙江 · 哈尔滨', radiusKm: 65 },
  { lat: 40.8426, lng: 111.7492, label: '中国 · 内蒙古 · 呼和浩特', radiusKm: 65 },
  { lat: 49.2122, lng: 119.7657, label: '中国 · 内蒙古 · 呼伦贝尔', radiusKm: 90 },
  { lat: 36.0611, lng: 103.8343, label: '中国 · 甘肃 · 兰州', radiusKm: 60 },
  { lat: 40.1421, lng: 94.662, label: '中国 · 甘肃 · 敦煌', radiusKm: 80 },
  { lat: 36.6171, lng: 101.7782, label: '中国 · 青海 · 西宁', radiusKm: 65 },
  { lat: 38.4872, lng: 106.2309, label: '中国 · 宁夏 · 银川', radiusKm: 60 },
  { lat: 43.8256, lng: 87.6168, label: '中国 · 新疆 · 乌鲁木齐', radiusKm: 75 },
  { lat: 43.9169, lng: 81.3241, label: '中国 · 新疆 · 伊犁', radiusKm: 90 },
  { lat: 48.7052, lng: 87.0185, label: '中国 · 新疆 · 喀纳斯/阿勒泰', radiusKm: 90 },
  { lat: 39.4704, lng: 75.9898, label: '中国 · 新疆 · 喀什', radiusKm: 80 },
  { lat: 29.6525, lng: 91.1721, label: '中国 · 西藏 · 拉萨', radiusKm: 75 },
  { lat: 29.6491, lng: 94.3615, label: '中国 · 西藏 · 林芝', radiusKm: 85 },

  // Asia & Oceania
  { lat: 35.6762, lng: 139.6503, label: '日本 · 东京', radiusKm: 55 },
  { lat: 35.4437, lng: 139.638, label: '日本 · 横滨/镰仓', radiusKm: 35 },
  { lat: 35.3606, lng: 138.7274, label: '日本 · 富士山/箱根', radiusKm: 45 },
  { lat: 35.0116, lng: 135.7681, label: '日本 · 京都', radiusKm: 30 },
  { lat: 34.6937, lng: 135.5023, label: '日本 · 大阪', radiusKm: 30 },
  { lat: 34.6851, lng: 135.8048, label: '日本 · 奈良', radiusKm: 25 },
  { lat: 34.6901, lng: 135.1955, label: '日本 · 神户', radiusKm: 25 },
  { lat: 35.1815, lng: 136.9066, label: '日本 · 名古屋', radiusKm: 45 },
  { lat: 33.5902, lng: 130.4017, label: '日本 · 福冈', radiusKm: 45 },
  { lat: 43.0618, lng: 141.3545, label: '日本 · 札幌/北海道', radiusKm: 70 },
  { lat: 26.2124, lng: 127.6809, label: '日本 · 冲绳', radiusKm: 70 },
  { lat: 37.5665, lng: 126.978, label: '韩国 · 首尔', radiusKm: 50 },
  { lat: 35.1796, lng: 129.0756, label: '韩国 · 釜山', radiusKm: 45 },
  { lat: 33.4996, lng: 126.5312, label: '韩国 · 济州岛', radiusKm: 55 },
  { lat: 1.3521, lng: 103.8198, label: '新加坡', radiusKm: 35 },
  { lat: 13.7563, lng: 100.5018, label: '泰国 · 曼谷', radiusKm: 55 },
  { lat: 18.7883, lng: 98.9853, label: '泰国 · 清迈', radiusKm: 55 },
  { lat: 7.8804, lng: 98.3923, label: '泰国 · 普吉岛', radiusKm: 55 },
  { lat: -8.4095, lng: 115.1889, label: '印尼 · 巴厘岛', radiusKm: 65 },
  { lat: 3.139, lng: 101.6869, label: '马来西亚 · 吉隆坡', radiusKm: 50 },
  { lat: 5.9804, lng: 116.0735, label: '马来西亚 · 亚庇/沙巴', radiusKm: 55 },
  { lat: 21.0278, lng: 105.8342, label: '越南 · 河内', radiusKm: 50 },
  { lat: 10.8231, lng: 106.6297, label: '越南 · 胡志明市', radiusKm: 50 },
  { lat: 16.0544, lng: 108.2022, label: '越南 · 岘港', radiusKm: 45 },
  { lat: 25.2048, lng: 55.2708, label: '阿联酋 · 迪拜', radiusKm: 55 },
  { lat: 4.1755, lng: 73.5093, label: '马尔代夫', radiusKm: 90 },
  { lat: -33.8688, lng: 151.2093, label: '澳大利亚 · 悉尼', radiusKm: 60 },
  { lat: -37.8136, lng: 144.9631, label: '澳大利亚 · 墨尔本', radiusKm: 60 },
  { lat: -36.8485, lng: 174.7633, label: '新西兰 · 奥克兰', radiusKm: 55 },
  { lat: -45.0312, lng: 168.6626, label: '新西兰 · 皇后镇', radiusKm: 75 },

  // Europe, Americas & Africa
  { lat: 51.5072, lng: -0.1276, label: '英国 · 伦敦', radiusKm: 55 },
  { lat: 55.9533, lng: -3.1883, label: '英国 · 爱丁堡', radiusKm: 45 },
  { lat: 48.8566, lng: 2.3522, label: '法国 · 巴黎', radiusKm: 55 },
  { lat: 43.7102, lng: 7.262, label: '法国 · 尼斯/南法', radiusKm: 55 },
  { lat: 52.3676, lng: 4.9041, label: '荷兰 · 阿姆斯特丹', radiusKm: 45 },
  { lat: 52.52, lng: 13.405, label: '德国 · 柏林', radiusKm: 50 },
  { lat: 48.1351, lng: 11.582, label: '德国 · 慕尼黑', radiusKm: 50 },
  { lat: 47.3769, lng: 8.5417, label: '瑞士 · 苏黎世', radiusKm: 45 },
  { lat: 46.6863, lng: 7.8632, label: '瑞士 · 因特拉肯/少女峰', radiusKm: 55 },
  { lat: 48.2082, lng: 16.3738, label: '奥地利 · 维也纳', radiusKm: 45 },
  { lat: 50.0755, lng: 14.4378, label: '捷克 · 布拉格', radiusKm: 45 },
  { lat: 47.4979, lng: 19.0402, label: '匈牙利 · 布达佩斯', radiusKm: 45 },
  { lat: 41.9028, lng: 12.4964, label: '意大利 · 罗马', radiusKm: 50 },
  { lat: 43.7696, lng: 11.2558, label: '意大利 · 佛罗伦萨', radiusKm: 45 },
  { lat: 45.4408, lng: 12.3155, label: '意大利 · 威尼斯', radiusKm: 40 },
  { lat: 45.4642, lng: 9.19, label: '意大利 · 米兰', radiusKm: 45 },
  { lat: 41.3874, lng: 2.1686, label: '西班牙 · 巴塞罗那', radiusKm: 45 },
  { lat: 40.4168, lng: -3.7038, label: '西班牙 · 马德里', radiusKm: 50 },
  { lat: 38.7223, lng: -9.1393, label: '葡萄牙 · 里斯本', radiusKm: 45 },
  { lat: 37.9838, lng: 23.7275, label: '希腊 · 雅典', radiusKm: 45 },
  { lat: 36.3932, lng: 25.4615, label: '希腊 · 圣托里尼', radiusKm: 35 },
  { lat: 64.1466, lng: -21.9426, label: '冰岛 · 雷克雅未克', radiusKm: 80 },
  { lat: 41.0082, lng: 28.9784, label: '土耳其 · 伊斯坦布尔', radiusKm: 55 },
  { lat: 30.0444, lng: 31.2357, label: '埃及 · 开罗', radiusKm: 55 },
  { lat: 40.7128, lng: -74.006, label: '美国 · 纽约', radiusKm: 60 },
  { lat: 37.7749, lng: -122.4194, label: '美国 · 旧金山', radiusKm: 65 },
  { lat: 34.0522, lng: -118.2437, label: '美国 · 洛杉矶', radiusKm: 70 },
  { lat: 47.6062, lng: -122.3321, label: '美国 · 西雅图', radiusKm: 55 },
  { lat: 36.1699, lng: -115.1398, label: '美国 · 拉斯维加斯', radiusKm: 55 },
  { lat: 21.3069, lng: -157.8583, label: '美国 · 夏威夷', radiusKm: 85 },
  { lat: 49.2827, lng: -123.1207, label: '加拿大 · 温哥华', radiusKm: 55 },
  { lat: 43.6532, lng: -79.3832, label: '加拿大 · 多伦多', radiusKm: 55 },
];

const DEG_TO_RAD = Math.PI / 180;

function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLng = (lng2 - lng1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * DEG_TO_RAD) *
      Math.cos(lat2 * DEG_TO_RAD) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function reverseGeocodeOffline(
  lat: number | null | undefined,
  lng: number | null | undefined,
): string | null {
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180 ||
    (lat === 0 && lng === 0)
  ) {
    return null;
  }

  let bestLabel: string | null = null;
  let bestDist = Infinity;

  const cosLat = Math.max(0.1, Math.cos((lat * Math.PI) / 180));
  for (const c of CITIES) {
    const maxR = c.radiusKm ?? 60;
    // Latitude-aware bounding-box pre-filter (safe at high latitudes & antimeridian)
    const latMargin = maxR / 110.5 + 0.05;
    if (Math.abs(c.lat - lat) > latMargin) continue;
    const lngMargin = maxR / (111.32 * cosLat) + 0.05;
    const dLng = Math.abs(c.lng - lng);
    const wrappedDLng = Math.min(dLng, 360 - dLng);
    if (wrappedDLng > lngMargin) continue;
    const dist = haversineKm(lat, lng, c.lat, c.lng);
    if (dist <= maxR && dist < bestDist) {
      bestDist = dist;
      bestLabel = c.label;
    }
  }

  return bestLabel;
}
