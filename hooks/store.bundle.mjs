import{createRequire as lt}from"node:module";import{existsSync as ht,unlinkSync as j,renameSync as Xt}from"node:fs";var w=class{#t;constructor(e){this.#t=e}pragma(e){let t=this.#t.prepare(`PRAGMA ${e}`).all();if(!t||t.length===0)return;if(t.length>1)return t;let r=Object.values(t[0]);return r.length===1?r[0]:t[0]}exec(e){let n="",t=null;for(let s=0;s<e.length;s++){let i=e[s];if(t)n+=i,i===t&&(t=null);else if(i==="'"||i==='"')n+=i,t=i;else if(i===";"){let o=n.trim();o&&this.#t.prepare(o).run(),n=""}else n+=i}let r=n.trim();return r&&this.#t.prepare(r).run(),this}prepare(e){let n=this.#t.prepare(e);return{run:(...t)=>n.run(...t),get:(...t)=>{let r=n.get(...t);return r===null?void 0:r},all:(...t)=>n.all(...t),iterate:(...t)=>n.iterate(...t)}}transaction(e){return this.#t.transaction(e)}close(){this.#t.close()}},C=class{#t;constructor(e){this.#t=e}pragma(e){let t=this.#t.prepare(`PRAGMA ${e}`).all();if(!t||t.length===0)return;if(t.length>1)return t;let r=Object.values(t[0]);return r.length===1?r[0]:t[0]}exec(e){return this.#t.exec(e),this}prepare(e){let n=this.#t.prepare(e);return{run:(...t)=>n.run(...t),get:(...t)=>n.get(...t),all:(...t)=>n.all(...t),iterate:(...t)=>typeof n.iterate=="function"?n.iterate(...t):n.all(...t)[Symbol.iterator]()}}transaction(e){return(...n)=>{this.#t.exec("BEGIN");try{let t=e(...n);return this.#t.exec("COMMIT"),t}catch(t){throw this.#t.exec("ROLLBACK"),t}}}close(){this.#t.close()}},y=null;function dt(c){let e=null;try{return e=new c(":memory:"),e.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)"),!0}catch{return!1}finally{try{e?.close()}catch{}}}function gt(c,e){let n=e!==void 0?e:globalThis.Bun;if(typeof n<"u"&&n!==null)return!0;let t=c??process.versions,[r,s]=(t.node??"0.0.0").split("."),i=Number(r),o=Number(s);return!Number.isFinite(i)||!Number.isFinite(o)?!1:i>22||i===22&&o>=5}function z(){if(!y){let c=lt(import.meta.url);if(globalThis.Bun){let e=c(["bun","sqlite"].join(":")).Database;y=function(t,r){let s=new e(t,{readonly:r?.readonly,create:!0}),i=new w(s);return r?.timeout&&i.pragma(`busy_timeout = ${r.timeout}`),i}}else if(gt()){let e=null;try{({DatabaseSync:e}=c(["node","sqlite"].join(":")))}catch{e=null}e&&dt(e)?y=function(t,r){let s=new e(t,{readOnly:r?.readonly??!1}),i=new C(s);return r?.timeout&&i.pragma(`busy_timeout = ${r.timeout}`),i}:y=c("better-sqlite3")}else y=c("better-sqlite3")}return y}function O(c){c.pragma("journal_mode = WAL"),c.pragma("synchronous = NORMAL");try{c.pragma("mmap_size = 268435456")}catch{}}function L(c){if(!ht(c))for(let e of["-wal","-shm"])try{j(c+e)}catch{}}function Y(c){for(let e of["","-wal","-shm"])try{j(c+e)}catch{}}function x(c){try{c.pragma("wal_checkpoint(TRUNCATE)")}catch{}try{c.close()}catch{}}function b(c,e=[100,500,2e3]){let n;for(let t=0;t<=e.length;t++)try{return c()}catch(r){let s=r instanceof Error?r.message:String(r);if(!s.includes("SQLITE_BUSY")&&!s.includes("database is locked"))throw r;if(n=r instanceof Error?r:new Error(s),t<e.length){let i=e[t],o=Date.now();for(;Date.now()-o<i;);}}throw new Error(`SQLITE_BUSY: database is locked after ${e.length} retries. Original error: ${n?.message}`)}function J(c){return c.includes("SQLITE_CORRUPT")||c.includes("SQLITE_NOTADB")||c.includes("database disk image is malformed")||c.includes("file is not a database")}var R=Symbol.for("__context_mode_live_dbs_v3__"),jt=(()=>{let c=globalThis;return c[R]||(c[R]=new Set,process.on("exit",()=>{for(let e of c[R])x(e);c[R].clear()})),c[R]})();import{readFileSync as Q,readdirSync as ot,unlinkSync as F,existsSync as M,statSync as N,openSync as tt,fstatSync as et,closeSync as nt}from"node:fs";import{createHash as rt}from"node:crypto";import{tmpdir as at}from"node:os";import{join as P}from"node:path";import{readdirSync as mt,statSync as ft,lstatSync as pt,realpathSync as K,existsSync as Et,readFileSync as kt}from"node:fs";import{join as G,extname as St,relative as q,sep as _t,resolve as yt}from"node:path";var bt=["node_modules",".git","dist","build",".next","coverage",".venv","__pycache__",".DS_Store"],Tt=[".md",".mdx",".txt",".json",".yaml",".yml",".ts",".tsx",".js",".jsx",".py",".rs",".go",".sh"],Rt=5,It=200;function Nt(c){let e="";for(let n=0;n<c.length;n++){let t=c[n];t==="*"?c[n+1]==="*"?(e+=".*",n++):e+="[^/]*":t==="?"?e+="[^/]":"\\^$.|+()[]{}".includes(t)?e+="\\"+t:e+=t}return new RegExp(`^${e}$`)}function V(c,e){if(e.length===0)return!1;let n=c.split("/").pop()??c;for(let t of e){if(!t.includes("/")&&!t.includes("*")){if(n===t||c.split("/").includes(t))return!0;continue}let r=Nt(t);if(r.test(c)||r.test(n))return!0}return!1}function At(c){let e=G(c,".gitignore");if(!Et(e))return[];try{return kt(e,"utf-8").split(/\r?\n/).map(t=>t.trim()).filter(t=>t.length>0&&!t.startsWith("#")&&!t.startsWith("!")).map(t=>t.replace(/^\//,"").replace(/\/$/,""))}catch{return[]}}function Dt(c,e){return q(c,e).split(_t).join("/")}function Z(c,e={}){let{include:n,exclude:t,maxDepth:r=Rt,maxFiles:s=It,extensions:i,respectGitignore:o=!0,followSymlinks:l=!1}=e,a;try{a=K(c)}catch{return{files:[],capped:!1,totalSeen:0}}let u=(i&&i.length>0?i:Tt).map(k=>(k.startsWith(".")?k:"."+k).toLowerCase()),d=[...bt,...t??[],...o?At(a):[]],h=n??[],m=[],g=new Set([a]),f=0,p=!1;function E(k,U){if(p||U>r)return;let B;try{B=mt(k,{withFileTypes:!0})}catch{return}for(let A of B){if(p)return;let _=G(k,A.name),v=Dt(a,_);if(V(v,d))continue;let H=A.isDirectory(),W=A.isFile(),$=!1;try{$=pt(_).isSymbolicLink()}catch{continue}if($){if(!l)continue;let S;try{S=K(_)}catch{continue}let D=q(a,S);if((D.startsWith("..")||yt(D)===S)&&D.startsWith("..")||g.has(S))continue;g.add(S);try{let X=ft(S);H=X.isDirectory(),W=X.isFile()}catch{continue}}if(H){E(_,U+1);continue}if(!W)continue;let ut=St(_).toLowerCase();if(u.includes(ut)&&!(h.length>0&&!V(v,h))){if(f++,m.length>=s){p=!0;return}m.push(_)}}}return E(a,0),{files:m,capped:p,totalSeen:f}}var T=new Set(["the","and","for","are","but","not","you","all","can","had","her","was","one","our","out","has","his","how","its","may","new","now","old","see","way","who","did","get","got","let","say","she","too","use","will","with","this","that","from","they","been","have","many","some","them","than","each","make","like","just","over","such","take","into","year","your","good","could","would","about","which","their","there","other","after","should","through","also","more","most","only","very","when","what","then","these","those","being","does","done","both","same","still","while","where","here","were","much","update","updates","updated","deps","dev","tests","test","add","added","fix","fixed","run","running","using"]);function ct(c){let e=new Set,n=[];for(let t of c){let r=t.toLowerCase();e.has(r)||(e.add(r),n.push(t))}return n}function wt(c,e="AND"){let n=ct(c.replace(/['"(){}[\]*:^~]/g," ").split(/\s+/).filter(s=>s.length>0&&!["AND","OR","NOT","NEAR"].includes(s.toUpperCase())));if(n.length===0)return'""';let t=n.filter(s=>!T.has(s.toLowerCase()));return(t.length>0?t:n).map(s=>`"${s}"`).join(e==="OR"?" OR ":" ")}function Ct(c,e="AND"){let n=c.replace(/["'(){}[\]*:^~]/g,"").trim();if(n.length<3)return"";let t=ct(n.split(/\s+/).filter(i=>i.length>=3));if(t.length===0)return"";let r=t.filter(i=>!T.has(i.toLowerCase()));return(r.length>0?r:t).map(i=>`"${i}"`).join(e==="OR"?" OR ":" ")}function Ot(c,e){if(c.length===0)return e.length;if(e.length===0)return c.length;let n=Array.from({length:e.length+1},(t,r)=>r);for(let t=1;t<=c.length;t++){let r=[t];for(let s=1;s<=e.length;s++)r[s]=c[t-1]===e[s-1]?n[s-1]:1+Math.min(n[s],r[s-1],n[s-1]);n=r}return n[e.length]}function Lt(c){return c<=4?1:c<=12?2:3}var I=4096,xt=24,Mt=3,Ft=200,Pt=5e3,st=80,Ut=.5;function ee(){let c=at(),e=0;try{let n=ot(c);for(let t of n){let r=t.match(/^ctxscribe-(\d+)\.db$/);if(!r)continue;let s=parseInt(r[1],10);if(s!==process.pid)try{process.kill(s,0)}catch{let i=P(c,t);for(let o of["","-wal","-shm"])try{F(i+o)}catch{}e++}}}catch{}return e}function ne(c,e){let n=0;try{if(!M(c))return 0;let t=Date.now()-e*24*60*60*1e3,r=ot(c).filter(s=>s.endsWith(".db"));for(let s of r)try{let i=P(c,s),l=N(i).mtimeMs<t;if(!l){let a=i+"-wal";if(M(a))try{let u=N(a);u.size>0&&Date.now()-u.mtimeMs>36e5&&(l=!0)}catch{}}if(l){for(let a of["","-wal","-shm"])try{F(i+a)}catch{}n++}}catch{}}catch{}return n}function Bt(c,e){let n=[],t=c.indexOf(e);for(;t!==-1;)n.push(t),t=c.indexOf(e,t+1);return n}function vt(c,e,n=30){if(c.length<2||e.length<2)return 0;let t=0,r=Math.min(c.length,e.length)-1;for(let s=0;s<r;s++){let i=c[s],o=c[s+1],l=e[s].length,a=0;for(let u of i){let d=u+l,h=d+n;for(;a<o.length&&o[a]<d;)a++;a<o.length&&o[a]<=h&&(t++,a++)}}return t}function Ht(c){if(c.length===0)return 1/0;if(c.length===1)return 0;let e=c,n=new Array(e.length).fill(0),t=1/0;for(;;){let r=1/0,s=-1/0,i=0;for(let l=0;l<e.length;l++){let a=e[l][n[l]];a<r&&(r=a,i=l),a>s&&(s=a)}let o=s-r;if(o<t&&(t=o),n[i]++,n[i]>=e[i].length)break}return t}var it=class c{#t;#n;#i;#a;#c;#u;#l;#h;#d;#g;#m;#f;#p;#E;#k;#S;#_;#y;#b;#T;#R;#I;#N;#A;#D;#w;#C;#O;#L;#x;#M;#F;#P;#U=0;static OPTIMIZE_EVERY=50;#e=new Map;static FUZZY_CACHE_SIZE=256;constructor(e){let n=z();this.#n=e??P(at(),`ctxscribe-${process.pid}.db`),L(this.#n);let t;try{t=new n(this.#n,{timeout:3e4}),O(t)}catch(r){let s=r instanceof Error?r.message:String(r);if(J(s)){Y(this.#n),L(this.#n);try{t=new n(this.#n,{timeout:3e4}),O(t)}catch(i){throw new Error(`Failed to create fresh DB after deleting corrupt file: ${i instanceof Error?i.message:String(i)}`)}}else throw r}this.#t=t,this.#X(),this.#j()}cleanup(){try{this.#t.close()}catch{}for(let e of["","-wal","-shm"])try{F(this.#n+e)}catch{}}#X(){this.#t.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        code_chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
        file_path TEXT,
        content_hash TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        source_category UNINDEXED,
        session_id UNINDEXED,
        event_id UNINDEXED,
        timestamp UNINDEXED,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        source_category UNINDEXED,
        session_id UNINDEXED,
        event_id UNINDEXED,
        timestamp UNINDEXED,
        tokenize='trigram'
      );

      CREATE TABLE IF NOT EXISTS vocabulary (
        word TEXT PRIMARY KEY
      );

      CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);
    `);try{let e=this.#t.prepare("SELECT name FROM pragma_table_xinfo('chunks')").all(),n=new Set(e.map(t=>t.name));e.length>0&&!n.has("source_category")&&(this.#t.exec("DROP TABLE IF EXISTS chunks"),this.#t.exec("DROP TABLE IF EXISTS chunks_trigram"),this.#t.exec(`
          CREATE VIRTUAL TABLE chunks USING fts5(
            title,
            content,
            source_id UNINDEXED,
            content_type UNINDEXED,
            source_category UNINDEXED,
            session_id UNINDEXED,
            event_id UNINDEXED,
            timestamp UNINDEXED,
            tokenize='porter unicode61'
          );
          CREATE VIRTUAL TABLE chunks_trigram USING fts5(
            title,
            content,
            source_id UNINDEXED,
            content_type UNINDEXED,
            source_category UNINDEXED,
            session_id UNINDEXED,
            event_id UNINDEXED,
            timestamp UNINDEXED,
            tokenize='trigram'
          );
        `))}catch{}try{this.#t.exec("ALTER TABLE sources ADD COLUMN file_path TEXT")}catch{}try{this.#t.exec("ALTER TABLE sources ADD COLUMN content_hash TEXT")}catch{}}#j(){this.#a=this.#t.prepare("INSERT INTO sources (label, chunk_count, code_chunk_count, file_path, content_hash) VALUES (?, 0, 0, ?, ?)"),this.#c=this.#t.prepare("INSERT INTO sources (label, chunk_count, code_chunk_count, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"),this.#u=this.#t.prepare("INSERT INTO chunks (title, content, source_id, content_type, source_category, session_id, event_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),this.#l=this.#t.prepare("INSERT INTO chunks_trigram (title, content, source_id, content_type, source_category, session_id, event_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),this.#h=this.#t.prepare("INSERT OR IGNORE INTO vocabulary (word) VALUES (?)"),this.#d=this.#t.prepare("DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?)"),this.#g=this.#t.prepare("DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE label = ?)"),this.#m=this.#t.prepare("DELETE FROM sources WHERE label = ?"),this.#f=this.#t.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ?
      ORDER BY rank
      LIMIT ?
    `),this.#p=this.#t.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ? ESCAPE '\\'
      ORDER BY rank
      LIMIT ?
    `),this.#E=this.#t.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `),this.#k=this.#t.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ?
      ORDER BY rank
      LIMIT ?
    `),this.#S=this.#t.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label LIKE ? ESCAPE '\\'
      ORDER BY rank
      LIMIT ?
    `),this.#_=this.#t.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `),this.#b=this.#t.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `),this.#T=this.#t.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ? ESCAPE '\\' AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `),this.#R=this.#t.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label = ? AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `),this.#I=this.#t.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `),this.#N=this.#t.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label LIKE ? ESCAPE '\\' AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `),this.#A=this.#t.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label = ? AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `),this.#y=this.#t.prepare("SELECT word FROM vocabulary WHERE length(word) BETWEEN ? AND ?"),this.#D=this.#t.prepare("SELECT label, chunk_count as chunkCount FROM sources ORDER BY id DESC"),this.#w=this.#t.prepare(`SELECT c.title, c.content, c.content_type, s.label
       FROM chunks c
       JOIN sources s ON s.id = c.source_id
       WHERE c.source_id = ?
       ORDER BY c.rowid`),this.#C=this.#t.prepare("SELECT chunk_count FROM sources WHERE id = ?"),this.#O=this.#t.prepare("SELECT content FROM chunks WHERE source_id = ?"),this.#x=this.#t.prepare("SELECT label, chunk_count, code_chunk_count, indexed_at, file_path, content_hash FROM sources WHERE label = ?"),this.#L=this.#t.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sources) AS sources,
        (SELECT COUNT(*) FROM chunks) AS chunks,
        (SELECT COUNT(*) FROM chunks WHERE content_type = 'code') AS codeChunks
    `),this.#M=this.#t.prepare("DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days'))"),this.#F=this.#t.prepare("DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days'))"),this.#P=this.#t.prepare("DELETE FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days')")}setDenyChecker(e){this.#i=e}index(e){let{content:n,path:t,source:r,attribution:s}=e,i=typeof n=="string"&&n.length>0;if(!i&&!t)throw new Error("Either content or path must be provided");let o;if(i)o=n;else{let h=tt(t,"r");try{if(!et(h).isFile())throw new Error(`refusing to index ${t}: not a regular file`);o=Q(h,"utf-8")}finally{nt(h)}}let l=r??t??"untitled",a=this.#K(o),u=t??void 0,d=u?rt("sha256").update(o).digest("hex"):void 0;return b(()=>this.#r(a,l,o,u,d,s))}indexDirectory(e){let{path:n,source:t,attribution:r,perFileDeny:s,...i}=e,o=Z(n,i),l=0,a=0,u=0,d=0;for(let h of o.files){if(s&&s(h)){u++;continue}try{let m=t?`${t}:${h}`:h,g=this.index({path:h,source:m,attribution:r});l++,a+=g.totalChunks}catch{d++}}return{filesIndexed:l,totalChunks:a,capped:o.capped,totalSeen:o.totalSeen,denied:u,failed:d,label:t??n}}indexPlainText(e,n,t=20,r,s=I){if(!e||e.trim().length===0)return this.#r([],n,"",void 0,void 0,r);let i=this.#G(e,t,s);return b(()=>this.#r(i.map(o=>({...o,hasCode:!1})),n,e,void 0,void 0,r))}indexJSON(e,n,t=I,r){if(!e||e.trim().length===0)return this.indexPlainText("",n,void 0,r,t);let s;try{s=JSON.parse(e)}catch{return this.indexPlainText(e,n,void 0,r,t)}let i=[];return this.#$(s,[],i,t),i.length===0?this.indexPlainText(e,n,void 0,r,t):b(()=>this.#r(i,n,e,void 0,void 0,r))}#r(e,n,t,r,s,i){let o=e.filter(h=>h.hasCode).length,l=i?.sessionId??"",a=i?.eventId??"",d=this.#t.transaction(()=>{if(this.#d.run(n),this.#g.run(n),this.#m.run(n),e.length===0){let f=this.#a.run(n,r??null,s??null);return Number(f.lastInsertRowid)}let h=this.#c.run(n,e.length,o,r??null,s??null),m=Number(h.lastInsertRowid),g=new Date().toISOString();for(let f of e){let p=f.hasCode?"code":"prose";this.#u.run(f.title,f.content,m,p,null,l,a,g),this.#l.run(f.title,f.content,m,p,null,l,a,g)}return m})();return t&&this.#J(t),this.#U++,this.#U%c.OPTIMIZE_EVERY===0&&this.#W(),{sourceId:d,label:n,totalChunks:e.length,codeChunks:o}}#B(e){return e.map(n=>({title:n.title,content:n.content,source:n.label,rank:n.rank,contentType:n.content_type,highlighted:n.highlighted,timestamp:n.timestamp??void 0,sessionId:n.session_id??""}))}#s(e,n){return n==="exact"?e:`%${e.replace(/\\/g,"\\\\").replace(/%/g,"\\%").replace(/_/g,"\\_")}%`}search(e,n=3,t,r="AND",s,i="like"){let o=wt(e,r),l,a;return t&&s?(l=i==="exact"?this.#R:this.#T,a=[o,this.#s(t,i),s,n]):t?(l=i==="exact"?this.#E:this.#p,a=[o,this.#s(t,i),n]):s?(l=this.#b,a=[o,s,n]):(l=this.#f,a=[o,n]),b(()=>this.#B(l.all(...a)))}searchTrigram(e,n=3,t,r="AND",s,i="like"){let o=Ct(e,r);if(!o)return[];let l,a;return t&&s?(l=i==="exact"?this.#A:this.#N,a=[o,this.#s(t,i),s,n]):t?(l=i==="exact"?this.#_:this.#S,a=[o,this.#s(t,i),n]):s?(l=this.#I,a=[o,s,n]):(l=this.#k,a=[o,n]),b(()=>this.#B(l.all(...a)))}fuzzyCorrect(e){let n=e.toLowerCase().trim();if(n.length<3)return null;if(this.#e.has(n)){let a=this.#e.get(n)??null;return this.#e.delete(n),this.#e.set(n,a),a}let t=Lt(n.length),r=this.#y.all(n.length-t,n.length+t),s=null,i=t+1,o=!1;for(let{word:a}of r){if(a===n){o=!0;break}let u=Ot(n,a);u<i&&(i=u,s=a)}let l=o?null:i<=t?s:null;if(this.#e.size>=c.FUZZY_CACHE_SIZE){let a=this.#e.keys().next().value;a!==void 0&&this.#e.delete(a)}return this.#e.set(n,l),l}#v(e,n,t,r,s="like"){let o=Math.max(n*2,10),l=this.search(e,o,t,"OR",r,s),a=this.searchTrigram(e,o,t,"OR",r,s),u=new Map,d=h=>`${h.source}::${h.title}`;for(let[h,m]of l.entries()){let g=d(m),f=u.get(g);f?f.score+=1/(60+h+1):u.set(g,{result:m,score:1/(60+h+1)})}for(let[h,m]of a.entries()){let g=d(m),f=u.get(g);f?f.score+=1/(60+h+1):u.set(g,{result:m,score:1/(60+h+1)})}return Array.from(u.values()).sort((h,m)=>m.score-h.score).slice(0,n).map(({result:h,score:m})=>({...h,rank:-m}))}#H(e,n){let t=n.toLowerCase().split(/\s+/).filter(i=>i.length>=2),r=t.filter(i=>!T.has(i)),s=r.length>0?r:t;return e.map(i=>{let o=i.title.toLowerCase(),l=s.filter(m=>o.includes(m)).length,a=i.contentType==="code"?.6:.3,u=l>0?a*(l/s.length):0,d=0,h=0;if(s.length>=2){let m=i.content.toLowerCase(),g=s.map(f=>Bt(m,f));if(!g.some(f=>f.length===0)){d=1/(1+Ht(g)/Math.max(m.length,1));let p=vt(g,s);h=.5*Math.min(1,p/4)}}return{result:i,boost:u+d+h}}).sort((i,o)=>o.boost-i.boost||i.result.rank-o.result.rank).map(({result:i})=>i)}searchWithFallback(e,n=3,t,r,s="like",i){this.#Y();let o=i?Math.max(n*8,40):n,l=this.#z(i),a=this.#v(e,o,t,r,s),u=l?a.filter(l):a;if(u.length>0)return this.#H(u.slice(0,n),e).map(p=>({...p,matchLayer:"rrf"}));let d=e.toLowerCase().trim().split(/\s+/).filter(f=>f.length>=3&&!T.has(f)),h=d.join(" "),g=d.map(f=>this.fuzzyCorrect(f)??f).join(" ");if(g!==h){let f=this.#v(g,o,t,r,s),p=l?f.filter(l):f;if(p.length>0)return this.#H(p.slice(0,n),g).map(k=>({...k,matchLayer:"rrf-fuzzy"}))}return[]}#z(e){return e?n=>{let t=n.sessionId??"";return t===""||e.has(t)}:null}lastRefreshCount=0;#Y(){this.lastRefreshCount=0;let e=0,n=this.#t.prepare("SELECT label, file_path, content_hash, indexed_at FROM sources WHERE file_path IS NOT NULL ORDER BY RANDOM()").all();for(let t of n)try{if(!M(t.file_path)||this.#i&&this.#i(t.file_path))continue;let r=N(t.file_path).mtime,s=new Date(t.indexed_at+"Z");if(r<=s)continue;if(e>=xt)break;e++;let i=tt(t.file_path,"r"),o;try{if(!et(i).isFile())continue;o=Q(i,"utf-8")}finally{nt(i)}if(rt("sha256").update(o).digest("hex")===t.content_hash){this.#t.prepare("UPDATE sources SET indexed_at = CURRENT_TIMESTAMP WHERE label = ?").run(t.label);continue}this.index({content:o,path:t.file_path,source:t.label}),this.lastRefreshCount++}catch{}}getSourceMeta(e){let n=this.#x.get(e);return n?{label:n.label,chunkCount:n.chunk_count,codeChunkCount:n.code_chunk_count,indexedAt:n.indexed_at,filePath:n.file_path??null,contentHash:n.content_hash??null}:null}listSources(){return this.#D.all()}getIndexState(){let e=this.#t.prepare("SELECT COALESCE(SUM(chunk_count), 0) AS total_chunks, COUNT(*) AS total_sources, MAX(indexed_at) AS last_indexed_at FROM sources").get();return{totalChunks:e.total_chunks??0,totalSources:e.total_sources??0,lastIndexedAt:e.last_indexed_at??void 0}}getChunksBySource(e){return this.#w.all(e).map(t=>({title:t.title,content:t.content,source:t.label,rank:0,contentType:t.content_type}))}getDistinctiveTerms(e,n=40){let t=this.#C.get(e);if(!t||t.chunk_count<3)return[];let r=t.chunk_count,s=2,i=Math.max(3,Math.ceil(r*.4)),o=new Map;for(let u of this.#O.iterate(e)){let d=new Set(u.content.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(h=>h.length>=3&&!T.has(h)));for(let h of d)o.set(h,(o.get(h)??0)+1)}return Array.from(o.entries()).filter(([,u])=>u>=s&&u<=i).map(([u,d])=>{let h=Math.log(r/d),m=Math.min(u.length/20,.5),g=/[_]/.test(u),f=u.length>=12,p=g?1.5:f?.8:0;return{word:u,score:h+m+p}}).sort((u,d)=>d.score-u.score).slice(0,n).map(u=>u.word)}getStats(){let e=this.#L.get();return{sources:e?.sources??0,chunks:e?.chunks??0,codeChunks:e?.codeChunks??0}}cleanupStaleSources(e){return this.#t.transaction(r=>(this.#M.run(r),this.#F.run(r),this.#P.run(r)))(e).changes}getDBSizeBytes(){try{return N(this.#n).size}catch{return 0}}#W(){try{this.#t.exec("INSERT INTO chunks(chunks) VALUES('optimize')"),this.#t.exec("INSERT INTO chunks_trigram(chunks_trigram) VALUES('optimize')")}catch{}}close(){this.#W(),x(this.#t)}#J(e){let n=e.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(s=>s.length>=3&&!T.has(s)),t=[...new Set(n)],r=0;this.#t.transaction(()=>{for(let s of t){let i=this.#h.run(s);r+=i.changes}})(),r>0&&this.#e.clear()}#K(e,n=I){let t=[],r=e.split(`
`),s=[],i=[],o="",l=()=>{let u=i.join(`
`).trim();if(u.length===0)return;let d=this.#tt(s,o),h=i.some(E=>/^`{3,}/.test(E));if(Buffer.byteLength(u)<=n){t.push({title:d,content:u,hasCode:h}),i=[];return}let m=u.split(/\n\n+/),g=[],f=1,p=()=>{if(g.length===0)return;let E=g.join(`

`).trim();if(E.length===0)return;let k=m.length>1?`${d} (${f})`:d;f++,t.push({title:k,content:E,hasCode:E.includes("```")}),g=[]};for(let E of m){g.push(E);let k=g.join(`

`);Buffer.byteLength(k)>n&&g.length>1&&(g.pop(),p(),g=[E])}p(),i=[]},a=0;for(;a<r.length;){let u=r[a];if(/^[-_*]{3,}\s*$/.test(u)){l(),a++;continue}let d=u.match(/^(#{1,4})\s+(.+)$/);if(d){l();let m=d[1].length,g=d[2].trim();for(;s.length>0&&s[s.length-1].level>=m;)s.pop();s.push({level:m,text:g}),o=g,i.push(u),a++;continue}let h=u.match(/^(`{3,})(.*)?$/);if(h){let m=h[1],g=[u];for(a++;a<r.length;){if(g.push(r[a]),r[a].startsWith(m)&&r[a].trim()===m){a++;break}a++}i.push(...g);continue}i.push(u),a++}return l(),t}#V(e,n){if(Buffer.byteLength(e)<=n)return e;let t="",r=0;for(let s of e){let i=Buffer.byteLength(s);if(r+i>n)break;t+=s,r+=i}return t.length===0?[...e][0]??"":t}#o(e,n,t){let r=[],s=[],i=1,o=()=>{if(s.length===0)return;let l=s.join(`
`),a=i===1?n:`${n} (${i})`;r.push({title:a,content:l}),i++,s=[]};for(let l of e){if(Buffer.byteLength(l)>t){o();let u=l,d=1;for(;u.length>0;){let h=this.#V(u,t);if(h.length<u.length){let g=h.lastIndexOf(" "),f=h.lastIndexOf(`
`),p=Math.max(g,f);p>h.length*Ut&&(h=h.slice(0,p))}let m=i===1&&d===1?n:`${n} (${i}.${d})`;r.push({title:m,content:h}),u=u.slice(h.length),d++,i++}continue}let a=s.length>0?s.join(`
`)+`
`+l:l;Buffer.byteLength(a)>t&&s.length>0&&o(),s.push(l)}return o(),r}#G(e,n,t=I){let r=e.split(/\n\s*\n/);if(r.length>=Mt&&r.length<=Ft&&r.every(a=>Buffer.byteLength(a)<Pt))return r.flatMap((a,u)=>{let d=a.trim();if(d.length===0)return[];let h=d.split(`
`)[0].slice(0,st)||`Section ${u+1}`;return Buffer.byteLength(d)<=t?[{title:h,content:d}]:this.#o(d.split(`
`),h,t)});let s=e.split(`
`);if(s.length<=n)return Buffer.byteLength(e)<=t?[{title:"Output",content:e}]:this.#o(s,"Output",t);let i=[],l=Math.max(n-2,1);for(let a=0;a<s.length;a+=l){let u=s.slice(a,a+n);if(u.length===0)break;let d=a+1,h=Math.min(a+u.length,s.length),m=u[0]?.trim().slice(0,st),g=u.join(`
`);if(Buffer.byteLength(g)<=t)i.push({title:m||`Lines ${d}-${h}`,content:g});else{let f=this.#o(u,m||`Lines ${d}-${h}`,t);i.push(...f)}}return i}#$(e,n,t,r){let s=n.length>0?n.join(" > "):"(root)",i=JSON.stringify(e,null,2);if(Buffer.byteLength(i)<=r&&!(typeof e=="object"&&e!==null&&!Array.isArray(e)&&Object.values(e).some(l=>typeof l=="object"&&l!==null))){t.push({title:s,content:i,hasCode:!0});return}if(typeof e=="object"&&e!==null&&!Array.isArray(e)){let o=Object.entries(e);if(o.length>0){for(let[l,a]of o)this.#$(a,[...n,l],t,r);return}t.push({title:s,content:i,hasCode:!0});return}if(Array.isArray(e)){this.#Q(e,n,t,r);return}t.push({title:s,content:i,hasCode:!1})}#q(e){if(e.length===0)return null;let n=e[0];if(typeof n!="object"||n===null||Array.isArray(n))return null;let t=["id","name","title","path","slug","key","label"],r=n;for(let s of t)if(s in r&&(typeof r[s]=="string"||typeof r[s]=="number"))return s;return null}#Z(e,n,t,r,s){let i=e?`${e} > `:"";if(!s)return n===t?`${i}[${n}]`:`${i}[${n}-${t}]`;let o=l=>String(l[s]);return r.length===1?`${i}${o(r[0])}`:r.length<=3?i+r.map(o).join(", "):`${i}${o(r[0])}\u2026${o(r[r.length-1])}`}#Q(e,n,t,r){let s=n.length>0?n.join(" > "):"(root)",i=this.#q(e),o=[],l=0,a=u=>{if(o.length===0)return;let d=this.#Z(s,l,u,o,i);t.push({title:d,content:JSON.stringify(o,null,2),hasCode:!0})};for(let u=0;u<e.length;u++){o.push(e[u]);let d=JSON.stringify(o,null,2);Buffer.byteLength(d)>r&&o.length>1&&(o.pop(),a(u-1),o=[e[u]],l=u)}a(l+o.length-1)}#tt(e,n){return e.length===0?n||"Untitled":e.map(t=>t.text).join(" > ")}};export{it as ContentStore,xt as REFRESH_BUDGET,ne as cleanupStaleContentDBs,ee as cleanupStaleDBs,wt as sanitizeQuery,Ct as sanitizeTrigramQuery};
