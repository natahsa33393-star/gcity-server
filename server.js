// Сервер рейтинга и платежей «Мой город» — Node без зависимостей
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=process.env.PORT||3000;
const APP_SECRET=process.env.APP_SECRET||'';
const FILE=path.join(__dirname,'data.json');
let db={players:{},orders:{}};
try{db=JSON.parse(fs.readFileSync(FILE,'utf8'))}catch(e){}
if(!db.players)db.players={};if(!db.orders)db.orders={};
let st=0;
function save(){if(st)return;st=setTimeout(function(){st=0;try{fs.writeFileSync(FILE,JSON.stringify(db))}catch(e){}},800)}
/* товары: id товара VK -> кристаллы (должны совпадать с настройками монетизации) */
var GEMS={'gems_50':50,'gems_150':150,'gems_250':250,'gems_500':500,'gems_1000':1000};
/* подпись параметров запуска VK */
function verify(q){
 try{
  var sign=q.get('sign');
  if(!sign)return{ok:false,uid:0};
  var uid=parseInt(q.get('vk_user_id')||'0',10);
  if(!uid)return{ok:false,uid:0};
  var secret=crypto.createHash('sha256').update((q.get('app_id')||'')+'_'+uid).digest();
  var keys=[];q.forEach(function(v,k){if(k!=='sign')keys.push(k)});
  keys.sort();
  var str=keys.map(function(k){return k+'='+q.get(k)}).join('&');
  var h=crypto.createHmac('sha256',secret).update(str).digest('hex');
  return{ok:h===sign,uid:uid}
 }catch(e){return{ok:false,uid:0}}
}
function clean(s){return String(s||'').replace(/[<>&"]/g,'').slice(0,24)}
function jres(res,code,obj){res.writeHead(code,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(obj))}
const srv=http.createServer(function(req,res){
 res.setHeader('Access-Control-Allow-Origin','*');
 res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
 res.setHeader('Access-Control-Allow-Headers','content-type');
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
 var u=new URL(req.url,'http://x');
 /* --- колбэк платежей VK --- */
 if(u.pathname==='/vk/pay'&&req.method==='POST'){
  var body='';
  req.on('data',function(d){body+=d;if(body.length>4096)req.destroy()});
  req.on('end',function(){
   try{
    var p={};
    body.split('&').forEach(function(kv){var t=kv.split('=');p[decodeURIComponent(t[0])]=decodeURIComponent((t[1]||'').replace(/\+/g,' '))});
    /* проверка сигнатуры VK (md5-склейка или reverse-md5) */
    if(APP_SECRET&&p.sig){
     var keys=Object.keys(p).filter(function(k){return k!=='sig'}).sort();
     var str=keys.map(function(k){return k+'='+p[k]}).join('');
     var s1=crypto.createHash('md5').update(str).digest('hex');
     var s2=crypto.createHash('md5').update(str).digest().reverse().map(function(b){var h=b.toString(16);return h.length<2?'0'+h:h}).join('');
     if(p.sig!==s1&&p.sig!==s2){res.writeHead(403);res.end(JSON.stringify({error:20}));return}
    }
    var oid=p.order_id||('vk'+Date.now());
    var gems=GEMS[p.item]||0;
    /* первый вызов: «готов платить» — фиксируем заказ, отвечаем charge */
    if(p.status==='ready_to_pay'&&gems>0){
     db.orders[oid]={uid:parseInt(p.receiver_id||'0',10),gems:gems,cl:0,t:Date.now()};save();
     res.writeHead(200,{'content-type':'application/json'});
     res.end(JSON.stringify({response:{order_id:parseInt(p.order_id,10)||0,app_order_id:p.item,status:'charge'}}));
     return}
    /* второй вызов: «списано» — если заказа нет (колбэк пришёл раньше), создаём */
    if(p.status==='charged'){
     if(!db.orders[oid]&&gems>0)db.orders[oid]={uid:parseInt(p.receiver_id||'0',10),gems:gems,cl:0,t:Date.now()};
     save();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({response:{order_id:parseInt(p.order_id,10)||0}}));
     return}
    res.writeHead(400);res.end(JSON.stringify({error:3}))
   }catch(e){res.writeHead(500);res.end(JSON.stringify({error:1}))}
  });
  return}
 /* --- топ --- */
 if(u.pathname==='/api/top'){
  var rows=[],k;
  for(k in db.players)rows.push({uid:parseInt(k,10),name:db.players[k].n||'Игрок '+k,score:db.players[k].s||0});
  rows.sort(function(a,b){return b.score-a.score});
  jres(res,200,{top:rows.slice(0,20)});
  return}
 /* --- счёт --- */
 if(u.pathname==='/api/score'&&req.method==='POST'){
  var v=verify(u.searchParams);
  if(!v.ok){jres(res,403,{error:'bad sign'});return}
  var body2='';
  req.on('data',function(d){body2+=d;if(body2.length>4096)req.destroy()});
  req.on('end',function(){
   var sc=0,nm='';
   try{var j=JSON.parse(body2);sc=parseInt(j.score,10);nm=clean(j.name)}catch(e){}
   if(!sc||sc<0)sc=0;if(sc>2e9)sc=2e9;if(!nm)nm='Мэр';
   var cur=db.players[v.uid];
   if(!cur||sc>(cur.s||0)){db.players[v.uid]={s:sc,n:nm,t:Date.now()};save()}
   var rank=1,k2;for(k2 in db.players)if(db.players[k2].s>sc)rank++;
   jres(res,200,{ok:1,rank:rank});
  });
  return}
 /* --- выдача оплаченных кристаллов --- */
 if(u.pathname==='/api/pending'){
  var v2=verify(u.searchParams);
  if(!v2.ok){jres(res,403,{error:'bad sign'});return}
  var sum=0,k3,ids=[];
  for(k3 in db.orders){var o=db.orders[k3];
   if(o.uid===v2.uid&&!o.cl){sum+=o.gems;ids.push(k3)}}
  if(u.searchParams.get('claim')==='1'&&sum>0){for(var q4=0;q4<ids.length;q4++)db.orders[ids[q4]].cl=1;save()}
  jres(res,200,{ok:1,gems:sum});
  return}
 res.writeHead(404,{'content-type':'text/plain'});res.end('not found');
});
srv.listen(PORT,function(){console.log('Сервер работает на порту '+PORT)});
