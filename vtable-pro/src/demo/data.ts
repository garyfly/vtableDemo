/**
 * 10 万行演示数据的生成器。
 *
 * 刻意写成「一次性生成一个普通数组」：这份数组就是需求里说的
 * 「全量导入的原始数据」，它不会进 Vue 的响应式系统（见 BulkData）。
 * 用固定种子的伪随机，保证每次刷新数据一致，探针才好断言。
 */

export interface OrderRow {
  id: number;
  orderNo: string;
  customer: string;
  owner: string;
  status: string;
  priority: string;
  city: string;
  channel: string;
  amount: number;
  progress: number;
  tags: string[];
  updatedAt: string;
  [key: string]: unknown;
}

/** mulberry32：固定种子伪随机 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const OWNERS = ['张三', '李四', '王五', '赵六', '钱七', '孙八', '周九', '吴十'];
export const STATUSES = ['待处理', '进行中', '待审核', '已完成', '已关闭'];
export const PRIORITIES = ['低', '中', '高', '紧急'];
export const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '西安', '南京', '苏州', '重庆', '长沙', '青岛', '厦门', '天津', '郑州', '合肥', '福州', '济南', '昆明'];
export const CHANNELS = ['官网', '电话', '渠道商', '展会', '老客户'];
export const TAGS = ['重点', '续费', '新签', '风险', '大客户', 'POC', '招投标', '定制', '海外', '民生'];

const PREFIX = ['华', '中', '东', '南', '北', '西', '新', '恒', '宏', '瑞', '联', '众', '天', '海', '金'];
const MID = ['信', '盛', '泰', '达', '通', '远', '洋', '润', '腾', '安', '创', '越', '元', '和'];
const MID2 = ['光', '维', '程', '科', '云', '智', '捷', '诚', '汇', '博', '润', '嘉', '启', '晟'];
const SUFFIX = ['科技有限公司', '数据集团', '信息技术有限公司', '网络科技公司', '智能装备有限公司', '供应链管理有限公司', '医疗科技有限公司', '新能源股份有限公司'];
const INDUSTRY = ['金融', '制造', '零售', '物流', '医疗', '教育', '能源', '政务'];

/**
 * 生成客户名池：15 × 14 × 14 × 8 = 23520 种组合，
 * 取 n 个不重复的（n 远小于组合数，所以不会退化成死循环；循环里仍然加了兜底上限）。
 */
function makeCustomers(r: () => number, n: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const MAX_ATTEMPTS = n * 40 + 1000;
  let attempts = 0;
  while (out.length < n && attempts < MAX_ATTEMPTS) {
    attempts++;
    const name = `${PREFIX[Math.floor(r() * PREFIX.length)]}${MID[Math.floor(r() * MID.length)]}${MID2[Math.floor(r() * MID2.length)]}${SUFFIX[Math.floor(r() * SUFFIX.length)]}`;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

/**
 * 生成 n 行。10 万行大约 40~60MB（行对象 + 少量数组字段），
 * 一次性构造完，之后整个 demo 里这份数据再没有被复制过。
 */
export function makeRows(n: number, seed = 20261006): OrderRow[] {
  const r = rng(seed);
  const customers = makeCustomers(r, Math.min(2000, Math.max(50, Math.floor(n / 50))));
  const rows: OrderRow[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const tagCount = 1 + Math.floor(r() * 3);
    const tags: string[] = [];
    for (let k = 0; k < tagCount; k++) {
      const t = TAGS[Math.floor(r() * TAGS.length)];
      if (!tags.includes(t)) tags.push(t);
    }
    const month = 1 + Math.floor(r() * 9);
    const day = 1 + Math.floor(r() * 28);
    const hour = Math.floor(r() * 24);
    const min = Math.floor(r() * 60);
    rows[i] = {
      id: i + 1,
      orderNo: `SO-2026-${pad(100000 + i, 7)}`,
      customer: customers[Math.floor(r() * customers.length)],
      owner: OWNERS[Math.floor(r() * OWNERS.length)],
      status: STATUSES[Math.floor(r() * STATUSES.length)],
      priority: PRIORITIES[Math.floor(r() * PRIORITIES.length)],
      city: CITIES[Math.floor(r() * CITIES.length)],
      channel: CHANNELS[Math.floor(r() * CHANNELS.length)],
      amount: Math.round(1000 + r() * 998000),
      progress: Math.floor(r() * 101),
      tags,
      updatedAt: `2026-${pad(month, 2)}-${pad(day, 2)} ${pad(hour, 2)}:${pad(min, 2)}`,
      industry: INDUSTRY[Math.floor(r() * INDUSTRY.length)],
    };
  }
  return rows;
}

/** 金额格式化（canvas 文本列用） */
export function formatMoney(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `¥${n.toLocaleString('zh-CN')}`;
}
