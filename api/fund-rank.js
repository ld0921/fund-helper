export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);
  const ft = url.searchParams.get('ft') || 'gp';
  const pn = Math.min(parseInt(url.searchParams.get('pn')) || 10, 50);
  const sc = url.searchParams.get('sc') || '1nzf';

  const allowedTypes = ['gp', 'hh', 'zs', 'zq', 'qdii'];
  if (!allowedTypes.includes(ft)) {
    return new Response(JSON.stringify({ error: 'invalid fund type' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const apiUrl = `https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=${ft}&rs=&gs=0&sc=${sc}&st=desc&pi=1&pn=${pn}&dx=1`;

  try {
    const resp = await fetch(apiUrl, {
      headers: {
        'Referer': 'https://fund.eastmoney.com/data/fundranking.html',
        'User-Agent': 'Mozilla/5.0 (compatible; FundHelper/1.0)'
      }
    });

    const text = await resp.text();

    // 解析 var rankData = {datas:[...],allRecords:...}; 格式
    const match = text.match(/var rankData\s*=\s*\{datas:\[(.*?)\],allRecords:(\d+)/s);
    if (!match) {
      return new Response(JSON.stringify({ error: 'parse failed', raw: text.substring(0, 200) }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 提取 datas 数组内容并构造合法 JSON
    const datasRaw = match[1];
    const allRecords = parseInt(match[2]) || 0;

    // datas 内容是 "fund1","fund2"... 格式，已经是合法的 JSON 字符串数组元素
    const jsonStr = `{"datas":[${datasRaw}],"allRecords":${allRecords}}`;

    return new Response(jsonStr, {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
