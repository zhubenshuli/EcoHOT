// 这个行业的分类体系：类别、标签词表、公司（主体）名录，以及防止张冠李戴的身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 换行业时：类别的 key 会出现在网址里（/all?category=…），上线后就不要再改；标签和名录可以随时增减。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * section 是日报里的分节标题（几个类别可以共用一节，按这里的顺序排）；guide 告诉结构抽取模型这一类收什么、
 * 和相邻类别的边界在哪（总的归类原则写在 prompts/structure.md 里）。
 * commentary 标出评论类（教程、观点）：日报写过的事又有评论类的后续报道，只占一行快讯（报道它的信源够多时除外）。
 * 没归上类的资料在日报里放进第一个 key 为 industry 的类别所在的节（没有就放最后一节）。
 * tagColor 是飞书推送卡片里跟在标题后面的这一类小标签的颜色（飞书 text_tag 的颜色名）。
 * feedLabel 是分类 RSS 标题里的名字（不写就用 label）。公开接口、RSS 和 MCP 里要把一类并进另一类发布，写在站点设置里（site/site.ts 的 PUBLIC_CATEGORIES）。
 */
export const CATEGORIES = [
  { key: "macro", tagColor: "indigo", label: "宏观", feedLabel: "宏观经济", section: "宏观政策与数据", guide: "央行货币政策、财政政策、GDP/CPI/PMI/失业率等宏观经济指标与统计数据发布。政策动向与权威宏观指标发布归此类。" },
  { key: "invest", tagColor: "cyan", label: "投资", feedLabel: "证券与大宗投资", section: "股票与大宗商品投资", guide: "A股与证券市场投资、行情异动、上市公司核心公告、黄金、原油及工业基础资源价格与大宗商品行情走势。" },
  { key: "finance", tagColor: "turquoise", label: "金融", feedLabel: "金融市场", section: "金融与资本市场", guide: "银行、债券市场、外汇、公募私募基金、金融监管机构与金融体系流动性核心动向。" },
  { key: "industry", tagColor: "orange", label: "产业", feedLabel: "产业经济", section: "产业与商业动态", guide: "实体经济重点产业链、新能源、先进制造、消费、地产等产业重大投融资、并购与商业经营活动。" },
  { key: "trade", tagColor: "violet", label: "贸易", feedLabel: "全球经贸", section: "全球经贸与进出口", guide: "国际经贸往来、关税调整、出口/进口数据、跨境供应链与多边经贸协定动态。" },
  { key: "policy", tagColor: "green", label: "政策", feedLabel: "政策法规", section: "经济法规与监管", guide: "发改委、商务部、金融监管总局、证监会等部委出台的经济监管法规、行业规范与合规动态。" },
  { key: "opinion", tagColor: "purple", label: "观点", section: "专家分析与观点", guide: "经济学家、行业分析师、权威智库的深度分析、市场观察、趋势研判与专访观点。", commentary: true },
] as const satisfies ReadonlyArray<{ key: string; tagColor: string; label: string; feedLabel?: string; section: string; guide: string; commentary?: true }>;

/**
 * 这个行业最受关注的一类发布（AI 行业是新模型）：日报报头的“N 个新模型”、改分类后修订已出的报告都按它数。
 * category 是类别，tag 是标签，两者都对上才算；unit 接在数字后面。
 * 没有这样一类的行业设成 null，报头就不显示这个数。
 */
export const RELEASE: { category: string; tag: string; unit: string } | null = null;

/** 周报月报的总述可以直接写、不必在报道里找到出处的行业通用词（小写）。站名会自动算进去。 */
export const PLAIN_TERMS: readonly string[] = [
  "gdp", "cpi", "ppi", "pmi", "fed", "ipo", "ceo", "lpr", "mlf", "etf", "pe", "pb", "roe", "opec", "wti", "comex",
  "降息", "加息", "降准", "美联储", "央行", "人民币", "美元", "通胀", "关税", "外汇", "国债",
  "a股", "上证指数", "深证成指", "创业板", "科创板", "北向资金", "两融", "牛市", "熊市",
  "黄金", "现货黄金", "伦敦金", "石油", "原油", "布伦特", "大宗商品", "基础资源",
  "铜", "铝", "碳酸锂", "铁矿石", "煤炭", "稀土", "有色金属", "贵金属",
];

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 */
export const ITEM_TYPES = [
  "macro_release",
  "market_move",
  "policy_regulatory",
  "industry_event",
  "research_report",
  "opinion_analysis",
  "practical_guide",
] as const;

// ── 标签词表 ────────────────────────────────────────────────────────────────────────────

/** 每篇资料的第一个标签必须是这些“分类标签”之一。 */
export const CATEGORY_TAGS = [
  "宏观数据", "货币政策", "财政政策", "金融市场", "资本市场", "A股投资", "大宗商品", "投资策略", "产业动态", "外贸进出口", "政策监管", "专家观点", "研报分析", "商业投资",
  "其他",
] as const;

/** 可选的主题标签。 */
export const TOPIC_TAGS = [
  "央行", "美联储", "A股", "港股", "美股", "人民币汇率", "通胀物价", "房地产", "新能源", "半导体", "供应链", "对外贸易", "就业民生", "大宗商品", "数字经济", "债券市场",
  "黄金", "石油", "基础资源", "有色金属", "投资策略", "贵金属", "能源化工", "北向资金",
] as const;

/** 可选的实体标签（机构、监管、国际组织）。 */
export const ENTITY_TAGS = [
  "中国人民银行", "美联储", "国家统计局", "财政部", "国家发改委", "商务部", "中国证监会", "欧洲央行", "国际货币基金组织", "世界银行",
  "上海证券交易所", "深圳证券交易所", "北京证券交易所", "上海期货交易所", "上海黄金交易所", "欧佩克",
] as const;

/** 模型常写的近义词，统一成词表里的写法。 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  宏观: "宏观数据", 经济数据: "宏观数据", 数据: "宏观数据", 指标: "宏观数据",
  货币: "货币政策", 加息: "货币政策", 降息: "货币政策", 降准: "货币政策", 利率: "货币政策",
  财政: "财政政策", 国债: "财政政策", 地方债: "财政政策",
  金融: "金融市场", 股市: "资本市场", 证券: "资本市场", 股票: "资本市场", 基金: "资本市场",
  外贸: "外贸进出口", 贸易: "外贸进出口", 出口: "外贸进出口", 进口: "外贸进出口", 关税: "外贸进出口",
  监管: "政策监管", 法规: "政策监管", 政策: "政策监管", 合规: "政策监管",
  观点: "专家观点", 评论: "专家观点", 分析: "研报分析", 研报: "研报分析", 研究: "研报分析", 报告: "研报分析",
  产业: "产业动态", 实体: "产业动态", 商业: "产业动态", 融资: "商业投资", 并购: "商业投资",
  // 股票与A股投资
  A股: "A股投资", 沪深: "A股", 沪指: "A股", 深指: "A股", 上证: "A股", 创业板: "A股", 科创板: "A股", 北交所: "A股", 选股: "A股投资",
  // 黄金与贵金属
  金价: "黄金", 现货黄金: "黄金", 伦敦金: "黄金", COMEX黄金: "黄金", 黄金ETF: "黄金", 贵金属: "贵金属", 白银: "贵金属",
  // 石油与能源
  原油: "石油", 油价: "石油", WTI: "石油", 布伦特: "石油", 柴油: "石油", 汽油: "石油", 欧佩克: "石油", 能源: "能源化工",
  // 基础资源与大宗商品
  铜: "基础资源", 阴极铜: "基础资源", 铝: "基础资源", 氧化铝: "基础资源", 碳酸锂: "基础资源", 锂矿: "基础资源", 铁矿石: "基础资源", 动力煤: "基础资源", 焦煤: "基础资源", 钢材: "基础资源", 螺纹钢: "基础资源", 稀土: "基础资源", 工业金属: "有色金属", 金属: "有色金属", 资源品: "基础资源", 大宗原料: "大宗商品",
  // 投资与投研
  投资: "投资策略", 投研: "投资策略", 策略: "投资策略", 资产配置: "投资策略",
};

// ── 机构与主体 ──────────────────────────────────────────────────────────────────────────

/**
 * 主体名录：id → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。
 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[]; orgNames?: string[]; otherNames?: string[] }> = {
  pbc: { name: "中国人民银行", displayTag: "央行", aliases: ["中国人民银行", "央行", "人行", "PBOC"], orgNames: ["中国人民银行"] },
  fed: { name: "美联储", displayTag: "美联储", aliases: ["美联储", "Federal Reserve", "Fed", "联储局"], orgNames: ["美联储", "Federal Reserve"] },
  stats: { name: "国家统计局", displayTag: "统计局", aliases: ["国家统计局", "国家统计局发布"], orgNames: ["国家统计局"] },
  mof: { name: "财政部", displayTag: "财政部", aliases: ["财政部", "中华人民共和国财政部"], orgNames: ["财政部"] },
  ndrc: { name: "国家发改委", displayTag: "发改委", aliases: ["国家发改委", "发改委", "国家发展和改革委员会"], orgNames: ["国家发改委"] },
  csrc: { name: "中国证监会", displayTag: "证监会", aliases: ["证监会", "中国证监会", "CSRC"], orgNames: ["中国证监会"] },
  mofcom: { name: "商务部", displayTag: "商务部", aliases: ["商务部", "中华人民共和国商务部"], orgNames: ["商务部"] },
  ecb: { name: "欧洲央行", displayTag: "欧洲央行", aliases: ["欧洲央行", "ECB", "European Central Bank"], orgNames: ["欧洲央行"] },
  imf: { name: "国际货币基金组织", displayTag: "IMF", aliases: ["IMF", "国际货币基金组织"], orgNames: ["IMF"] },
  "world-bank": { name: "世界银行", displayTag: "世行", aliases: ["世界银行", "World Bank"], orgNames: ["世界银行"] },
  sse: { name: "上海证券交易所", displayTag: "上交所", aliases: ["上海证券交易所", "上交所", "SSE"], orgNames: ["上海证券交易所"] },
  szse: { name: "深圳证券交易所", displayTag: "深交所", aliases: ["深圳证券交易所", "深交所", "SZSE"], orgNames: ["深圳证券交易所"] },
  bse: { name: "北京证券交易所", displayTag: "北交所", aliases: ["北京证券交易所", "北交所", "BSE"], orgNames: ["北京证券交易所"] },
  shfe: { name: "上海期货交易所", displayTag: "上期所", aliases: ["上海期货交易所", "上期所", "SHFE"], orgNames: ["上海期货交易所"] },
  sge: { name: "上海黄金交易所", displayTag: "上金所", aliases: ["上海黄金交易所", "上金所", "SGE"], orgNames: ["上海黄金交易所"] },
  opec: { name: "欧佩克", displayTag: "OPEC", aliases: ["欧佩克", "OPEC", "石油输出国组织", "OPEC+"], orgNames: ["石油输出国组织", "OPEC"] },
};

/**
 * 身份词典：摘要和标题里出现的实体，必须在原文里也出现过，否则退回原标题、丢掉摘要（防止模型张冠李戴）。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "pbc", name: "中国人民银行", patterns: [/中国人民银行|人行|央行/i] },
  { id: "fed", name: "美联储", patterns: [/美联储|\bFederal\s+Reserve\b|\bFed\b/i] },
  { id: "stats", name: "国家统计局", patterns: [/国家统计局/i] },
  { id: "mof", name: "财政部", patterns: [/财政部/i] },
  { id: "ndrc", name: "国家发改委", patterns: [/发改委|国家发展和改革委员会/i] },
  { id: "csrc", name: "中国证监会", patterns: [/证监会|中国证监会/i] },
  { id: "mofcom", name: "商务部", patterns: [/商务部/i] },
  { id: "ecb", name: "欧洲央行", patterns: [/欧洲央行|\bECB\b/i] },
  { id: "imf", name: "国际货币基金组织", patterns: [/\bIMF\b|国际货币基金组织/i] },
  { id: "world-bank", name: "世界银行", patterns: [/世界银行|\bWorld\s+Bank\b/i] },
  { id: "sse", name: "上海证券交易所", patterns: [/上海证券交易所|上交所/i] },
  { id: "szse", name: "深圳证券交易所", patterns: [/深圳证券交易所|深交所/i] },
  { id: "bse", name: "北京证券交易所", patterns: [/北京证券交易所|北交所/i] },
  { id: "shfe", name: "上海期货交易所", patterns: [/上海期货交易所|上期所/i] },
  { id: "sge", name: "上海黄金交易所", patterns: [/上海黄金交易所|上金所/i] },
  { id: "opec", name: "欧佩克", patterns: [/欧佩克|\bOPEC\b|石油输出国组织/i] },
];

/** 这些域名上的文章，发布方就是对应的机构。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "pbc", domains: ["pbc.gov.cn"] },
  { entityId: "fed", domains: ["federalreserve.gov"] },
  { entityId: "stats", domains: ["stats.gov.cn"] },
  { entityId: "mof", domains: ["mof.gov.cn"] },
  { entityId: "ndrc", domains: ["ndrc.gov.cn"] },
  { entityId: "csrc", domains: ["csrc.gov.cn"] },
  { entityId: "mofcom", domains: ["mofcom.gov.cn"] },
  { entityId: "ecb", domains: ["ecb.europa.eu"] },
  { entityId: "imf", domains: ["imf.org"] },
  { entityId: "world-bank", domains: ["worldbank.org"] },
  { entityId: "sse", domains: ["sse.com.cn"] },
  { entityId: "szse", domains: ["szse.cn"] },
  { entityId: "bse", domains: ["bse.cc"] },
  { entityId: "shfe", domains: ["shfe.com.cn"] },
  { entityId: "sge", domains: ["sge.com.cn"] },
  { entityId: "opec", domains: ["opec.org"] },
];

/** 原文里的这些写法也算提到了对应机构。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [];
