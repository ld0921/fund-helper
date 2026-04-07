const CURATED_FUNDS = [
  {code:'005827',name:'易方达蓝筹精选混合',type:'混合型',cat:'active',label:'主动权益',manager:'张坤',mgrYears:13.5,stars:4,risk:'R4',size:310.21,r1:-6.75,r3:-11.51,maxDD:57.9,fee:0.15,vol:0,tags:['消费','医药','白酒'],reason:'张坤代表作，专注消费医药龙头，价值投资体系成熟，历经多轮牛熊考验。持仓集中于白酒、医药等消费核心资产，适合认同价值投资理念的长线投资者。'},
  {code:'110011',name:'易方达优质精选混合(QDII)',type:'混合型',cat:'active',label:'主动权益',manager:'张坤',mgrYears:13.5,stars:4,risk:'R4',size:113.85,r1:-7.76,r3:-11.28,maxDD:61.2,fee:0.15,vol:0,tags:['消费','白酒','医药'],reason:'张坤管理时间最长的产品（原名易方达中小盘），穿越多轮牛熊，超长任期积累丰富经验。持仓以消费白酒为主，风格稳定，适合长期持有。'},
  {code:'161005',name:'富国天惠成长混合(LOF)A',type:'混合型',cat:'active',label:'主动权益',manager:'朱少醒',mgrYears:20.4,stars:4,risk:'R4',size:211.02,r1:17.93,r3:10.81,maxDD:65.2,fee:0.15,vol:0,tags:['成长','科技','消费'],reason:'朱少醒管理超20年，国内任职时间最长的基金经理之一。选股覆盖成长与消费，回撤控制能力突出，长期配置价值高。'},
  {code:'163402',name:'兴全趋势投资混合(LOF)',type:'混合型',cat:'active',label:'主动权益',manager:'杨世进',mgrYears:5.3,stars:5,risk:'R4',size:140.12,r1:33.25,r3:20.83,maxDD:87.7,fee:0.15,vol:0,tags:['均衡','成长','价值'],reason:'经典趋势产品，选股均衡多元，下行风险控制优于同类，适合作为权益基金底仓。'},
  {code:'003095',name:'中欧医疗健康混合A',type:'混合型',cat:'active',label:'主动权益',manager:'葛兰',mgrYears:10.7,stars:4,risk:'R4',size:138.43,r1:6.86,r3:-22.69,maxDD:68.5,fee:0.15,vol:0,tags:['医疗','创新药','器械'],reason:'医疗健康专精，覆盖创新药、CXO、医疗器械。行业集中度高，波动大，仅适合看好医疗长期需求且能承受高波动的投资者。'},
  {code:'260108',name:'景顺长城新兴成长混合A',type:'混合型',cat:'active',label:'主动权益',manager:'刘彦春',mgrYears:16.9,stars:4,risk:'R4',size:158.8,r1:-10.97,r3:-30.49,maxDD:77.9,fee:0.15,vol:0,tags:['消费','成长','港股'],reason:'刘彦春深度研究消费成长方向，任职超16年。持仓偏重消费与港股，选股集中度高，波动较大，适合看好消费赛道的长线投资者。'},
  {code:'460300',name:'华泰柏瑞沪深300ETF联接A',type:'指数型',cat:'index',label:'指数基金',manager:'柳军',mgrYears:16.8,stars:5,risk:'R4',size:4222.58,r1:19.27,r3:26.4,maxDD:46.5,fee:0.12,vol:0,tags:['沪深300','宽基','蓝筹'],reason:'跟踪沪深300ETF(510300)的联接基金A类份额，支持场外申购（支付宝等），跟踪A股核心蓝筹，费率极低，长期定投首选。'},
  {code:'009051',name:'易方达中证红利ETF联接A',type:'指数型',cat:'index',label:'指数基金',manager:'林伟斌',mgrYears:11.9,stars:5,risk:'R3',size:118.05,r1:12.25,r3:29.45,maxDD:22.5,fee:0.12,vol:0,tags:['高股息','红利','防御'],reason:'跟踪中证红利ETF(515180)的联接基金A类份额，支持场外申购。聚焦高股息低估值标的，防御性强，适合追求稳定现金流的投资者。'},
  {code:'006327',name:'易方达中证海外互联网50ETF联接A',type:'QDII',cat:'qdii',label:'QDII海外',manager:'余海燕',mgrYears:14.3,stars:5,risk:'R4',size:398.59,r1:-15.1,r3:33.73,maxDD:73.4,fee:0.02,vol:0,tags:['互联网','港股','科技'],reason:'跟踪中概互联ETF(513050)的联接基金A类份额，支持场外申购。覆盖腾讯、阿里、美团等互联网龙头，适合看好中概长期复苏。'},
  {code:'110026',name:'易方达创业板ETF联接A',type:'指数型',cat:'index',label:'指数基金',manager:'成曦',mgrYears:9.9,stars:5,risk:'R4',size:1004.46,r1:52.72,r3:50.01,maxDD:69.7,fee:0.12,vol:0,tags:['创业板','科技','成长'],reason:'跟踪创业板ETF(159915)的联接基金A类份额，支持场外申购。弹性大，成长股集中，仅适合激进型投资者少量配置。'},
  {code:'160119',name:'南方中证500ETF联接A',type:'指数型',cat:'index',label:'指数基金',manager:'罗文杰',mgrYears:12.9,stars:5,risk:'R4',size:1446.9,r1:34.17,r3:36.88,maxDD:63.2,fee:0.12,vol:0,tags:['中证500','中盘','成长'],reason:'跟踪中证500ETF(510500)的联接基金A类份额，支持场外申购。覆盖500只中等市值股票，与沪深300互补，成长性更强。'},
  {code:'160706',name:'嘉实沪深300ETF联接(LOF)A',type:'指数型',cat:'index',label:'指数基金',manager:'刘珈吟',mgrYears:10,stars:5,risk:'R4',size:1971.24,r1:19.24,r3:26.4,maxDD:45.9,fee:0.12,vol:0,tags:['沪深300','宽基','低费率'],reason:'跟踪嘉实沪深300ETF(159919)的联接基金A类份额，支持场外申购。老牌沪深300联接，跟踪精准，适合长期定投。'},
  {code:'110017',name:'易方达增强回报债券A',type:'债券型',cat:'bond',label:'债券基金',manager:'王晓晨',mgrYears:14.6,stars:5,risk:'R3',size:316.96,r1:5.55,r3:17.39,maxDD:21.1,fee:0.07,vol:0,tags:['信用债','增强','稳健'],reason:'长期业绩位居债基前列，信用债与利率债均衡，适度增强收益，风险控制优秀。'},
  {code:'000171',name:'易方达裕丰回报债券A',type:'债券型',cat:'bond',label:'债券基金',manager:'张清华',mgrYears:12.2,stars:4,risk:'R3',size:152.65,r1:7.09,r3:16.01,maxDD:26,fee:0.05,vol:0,tags:['债券','增强','稳健'],reason:'债券增强型产品，适合追求稳健收益的投资者，替代银行理财。'},
  {code:'070009',name:'嘉实超短债债券C',type:'债券型',cat:'bond',label:'债券基金',manager:'王亚洲',mgrYears:10.7,stars:5,risk:'R1',size:63.48,r1:1.54,r3:6.55,maxDD:2.3,fee:0,vol:0,tags:['超短债','流动性','保守'],reason:'持仓期限极短，流动性优异，收益高于货币基金，风险接近零，适合短期过渡资金。'},
  {code:'000198',name:'天弘余额宝货币',type:'货币型',cat:'money',label:'货币基金',manager:'王登峰',mgrYears:11.8,stars:3,risk:'R1',size:6891.5,r1:1.15,r3:4.62,maxDD:0.0,fee:0,vol:0,tags:['货币','余额宝','流动性'],reason:'余额宝对接货币基金，规模最大，流动性最佳，T+0快速赎回。注意：可能暂停申购，系统将自动推荐替代基金。'},
  {code:'003003',name:'华夏现金增利货币A/E',type:'货币型',cat:'money',label:'货币基金',manager:'曲波',mgrYears:18.2,stars:3,risk:'R1',size:593.88,r1:1.13,r3:4.57,maxDD:0.0,fee:0,vol:0,tags:['货币','稳健','现金管理'],reason:'华夏基金旗下货币基金，规模较大，收益稳定，支持支付宝申购，适合资金备用仓。'},
  {code:'161125',name:'易方达标普500指数人民币A',type:'QDII',cat:'qdii',label:'QDII海外',manager:'刘依姗',mgrYears:1.3,stars:4,risk:'R4',size:14.75,r1:13.32,r3:66.24,maxDD:32.9,fee:0.08,vol:0,tags:['美股','标普500','全球配置'],reason:'跟踪标普500，投资苹果微软英伟达等美股核心资产，历史年化约10%+，全球配置首选。'},
  {code:'270042',name:'广发纳斯达克100ETF联接人民币(QDII)A',type:'QDII',cat:'qdii',label:'QDII海外',manager:'刘杰',mgrYears:12,stars:5,risk:'R5',size:108.44,r1:18.61,r3:88.66,maxDD:31.2,fee:0.08,vol:0,tags:['美股','纳斯达克','科技'],reason:'跟踪纳斯达克100，高度集中科技巨头，弹性极大，长期表现优异，适合激进型配置。'},
  {code:'040046',name:'华安纳斯达克100ETF联接(QDII)A',type:'QDII',cat:'qdii',label:'QDII海外',manager:'倪斌',mgrYears:7.5,stars:4,risk:'R4',size:55.2,r1:17.03,r3:85.36,maxDD:31.2,fee:0.08,vol:0,tags:['美股','纳斯达克','科技'],reason:'华安旗下纳斯达克100联接基金，管理经验丰富，费率合理，适合配置美股科技赛道的投资者。'},
  {code:'006479',name:'广发纳斯达克100ETF联接人民币(QDII)C',type:'QDII',cat:'qdii',label:'QDII海外',manager:'刘杰',mgrYears:12,stars:5,risk:'R4',size:65.44,r1:18.38,r3:87.53,maxDD:31.4,fee:0,vol:0,tags:['美股','纳斯达克','联接'],reason:'广发纳斯达克100的C类份额，免申购费收销售服务费，适合短期持有或小额定投。'},
];

// ═══════════════ 基金元数据增强（风格/行业/流动性风险） ═══════════════
const FUND_META = {
  '005827':{style:'large_value',industry:'消费',instPct:45,sizeQ:[-2,-5,-3,-1]},
  '110011':{style:'large_value',industry:'消费',instPct:52,sizeQ:[-3,-5,-4,-2]},
  '161005':{style:'large_growth',industry:'均衡',instPct:35,sizeQ:[0,-2,-1,1]},
  '163402':{style:'large_blend',industry:'均衡',instPct:30,sizeQ:[-1,-2,-1,0]},
  '003095':{style:'mid_growth',industry:'医药',instPct:40,sizeQ:[-8,-12,-5,-3]},
  '260108':{style:'large_growth',industry:'消费',instPct:48,sizeQ:[-5,-8,-6,-2]},
  '460300':{style:'large_blend',industry:'宽基',instPct:55,sizeQ:[5,3,8,10]},
  '009051':{style:'large_value',industry:'红利',instPct:60,sizeQ:[3,5,8,12]},
  '006327':{style:'large_growth',industry:'科技',instPct:38,sizeQ:[2,-5,0,5]},
  '110026':{style:'mid_growth',industry:'科技',instPct:42,sizeQ:[-2,-5,-3,0]},
  '160119':{style:'mid_blend',industry:'宽基',instPct:50,sizeQ:[1,-3,0,2]},
  '160706':{style:'large_blend',industry:'宽基',instPct:58,sizeQ:[2,1,3,5]},
  '110017':{style:'bond_credit',industry:'债券',instPct:65,creditGrade:'AA+',duration:2.5,sizeQ:[1,0,2,3]},
  '000171':{style:'bond_rate',industry:'债券',instPct:72,creditGrade:'AAA',duration:1.8,sizeQ:[-1,0,1,2]},
  '070009':{style:'bond_short',industry:'债券',instPct:55,creditGrade:'AAA',duration:0.3,sizeQ:[2,3,1,0]},
  '000198':{style:'money',industry:'货币',instPct:15,sizeQ:[0,0,0,0]},
  '003003':{style:'money',industry:'货币',instPct:30,sizeQ:[0,1,0,0]},
  '161125':{style:'large_blend',industry:'美股',instPct:35,sizeQ:[3,5,8,10]},
  '270042':{style:'large_growth',industry:'科技',instPct:28,sizeQ:[2,3,5,8]},
  '040046':{style:'large_blend',industry:'美股',instPct:32,sizeQ:[1,2,3,5]},
  '006479':{style:'large_blend',industry:'美股',instPct:25,sizeQ:[2,3,5,8]},
};
const STYLE_LABELS = {large_value:'大盘价值',large_blend:'大盘均衡',large_growth:'大盘成长',mid_value:'中盘价值',mid_blend:'中盘均衡',mid_growth:'中盘成长',bond_credit:'信用债',bond_rate:'利率债',bond_short:'短债',money:'货币'};
function getMeta(code){ return FUND_META[code]||{}; }

// ═══════════════ 暂停申购基金及替代方案 ═══════════════
// 支付宝等平台暂停申购的基金代码列表（需定期更新）
const SUSPENDED_FUNDS = new Set(['000198']); // 天弘余额宝货币
// 暂停基金的替代方案映射（同类型、同风险等级）
const FUND_ALTERNATIVES = {
  '000198': '003003', // 余额宝暂停 → 华夏现金增利货币
};
// 检查基金是否可购买，若暂停则返回替代基金代码
function checkFundAvailability(code){
  if(SUSPENDED_FUNDS.has(code)){
    return FUND_ALTERNATIVES[code] || null;
  }
  return code;
}

// 支付宝1折申购费率（第三方平台通常1折优惠，C类份额免申购费）
function getDefaultFee(cat){ return {active:0.15,index:0.012,bond:0.05,money:0,qdii:0.08}[cat]||0.10; }

// ═══════════════ 波动率估算 + 相关性矩阵 ═══════════════
const DD_TO_VOL = { active:2.8, index:3.0, bond:1.8, money:1.2, qdii:2.5 };
function estimateVol(f){
  if(f.vol > 0) return f.vol;
  return (f.maxDD||0) / (DD_TO_VOL[f.cat]||2.5);
}
const CORR_MATRIX = {
  active: { active:1.0, index:0.92, bond:-0.15, money:0.0, qdii:0.55 },
  index:  { active:0.92, index:1.0, bond:-0.10, money:0.0, qdii:0.50 },
  bond:   { active:-0.15, index:-0.10, bond:1.0, money:0.30, qdii:-0.05 },
  money:  { active:0.0, index:0.0, bond:0.30, money:1.0, qdii:0.0 },
  qdii:   { active:0.55, index:0.50, bond:-0.05, money:0.0, qdii:1.0 },
};
// CAT_NAMES
const CAT_NAMES  = { active:'主动权益', index:'指数基金', bond:'债券基金', money:'货币基金', qdii:'QDII海外' };
// CAT_TAG
const CAT_TAG={'active':'tag-active','index':'tag-index','bond':'tag-bond','money':'tag-money','qdii':'tag-qdii'};

// ═══════════════ 估值信号：主要宽基指数PE百分位（静态内置，更新于2026-04） ═══════════════
// 百分位基于近10年历史数据，<30%=低估，>70%=高估
// 数据来源：Wind/理杏仁公开数据，每次「更新数据」时可手动刷新
const INDEX_VALUATION = {
  '000300': { name:'沪深300', pePct:42, pbPct:38, updated:'2026-04' }, // PE百分位42%，中性偏低
  '000905': { name:'中证500', pePct:35, pbPct:30, updated:'2026-04' }, // 中等偏低估
  '399006': { name:'创业板',  pePct:55, pbPct:52, updated:'2026-04' }, // 中性
  '000852': { name:'中证1000',pePct:32, pbPct:28, updated:'2026-04' }, // 偏低估
  '000016': { name:'上证50',  pePct:38, pbPct:35, updated:'2026-04' }, // 中性偏低
};
// 基金代码 → 对应指数代码映射
const FUND_VALUATION_MAP = {
  '460300':'000300','160706':'000300', // 沪深300联接
  '160119':'000905',                   // 中证500联接
  '110026':'399006',                   // 创业板联接
};
