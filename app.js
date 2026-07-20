/* ============================================================
   MD Editor — application logic
   Sections:
     1. Markdown renderer (markdown → HTML)
     2. UI helpers (toast + confirm modal)
     3. State & elements
    3b. Mermaid diagrams (lazy ESM import)
     4. Live render / autosave
     5. Editable preview (HTML → markdown via Turndown)
     6. Editor keyboard shortcuts
     7. Save / Open files
     8. Export menu (HTML / PDF / Markdown)
     9. Copy menu
    10. Text direction (LTR / RTL)
    11. Theme toggle
   11b. Reading mode
    12. Resizable panes
    13. Synced scrolling
    14. Mobile view switch
    15. Preview formatting toolbar (select or right-click)
    16. Drag & drop import
    17. Find & Replace (Ctrl/Cmd+F)
   ============================================================ */

/* Wrapped so none of the ~90 names below leak into window, where they could
   collide with a CDN library (this file defines render, update, save, main…).
   An IIFE rather than type="module" so the app still opens from file://. */
(function(){
"use strict";

/* ============================================================
   1. Markdown renderer — minimal, dependency-free
   ============================================================ */
function escapeHtml(s){ return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

/* Attribute/URL safety. Text reaching inline() is already HTML-escaped by
   escapeHtml (& < >), so only quotes still need escaping here. */
const UNSAFE_SCHEME=/^\s*(?:javascript|vbscript|data)\s*:/i;
function attrValue(s){ return s.replace(/"/g,"&quot;"); }
function safeHref(u){ return UNSAFE_SCHEME.test(u) ? "#" : attrValue(u); }
function safeSrc(u){
  if(/^\s*data:image\//i.test(u)) return attrValue(u); // inline/base64 images are fine
  return UNSAFE_SCHEME.test(u) ? "" : attrValue(u);
}

function inline(t){
  // Math is pulled out FIRST and re-inserted last, so TeX like a_b^* is never
  // mangled by the emphasis/code replacements below. `\$` stays a literal $,
  // and "$ 5 and $10" style prices are left alone (space-padded ≠ math).
  const maths=[];
  t = t.replace(/\\\$/g,"\x00D\x00")
       .replace(/\$([^$\n]+?)\$/g,(m,tex)=>
         /^\s|\s$/.test(tex) ? m : "\x00M"+(maths.push(tex)-1)+"\x00");
  // footnote references — an undefined label stays literal text
  t = t.replace(FOOTNOTE_REF,(m,label)=>footnoteRef(label) || m);
  // images ![alt](src)
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (m,alt,src,ti)=>`<img src="${safeSrc(src)}" alt="${attrValue(alt)}"${ti?` title="${attrValue(ti)}"`:""}>`);
  // links [text](href)
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (m,txt,href,ti)=>`<a href="${safeHref(href)}"${ti?` title="${attrValue(ti)}"`:""} target="_blank" rel="noopener noreferrer">${txt}</a>`);
  // bold, italic, strikethrough, inline code
  t = t.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>")
       .replace(/__([^_]+)__/g,"<strong>$1</strong>")
       .replace(/(^|[^*])\*([^*]+)\*/g,"$1<em>$2</em>")
       .replace(/(^|[^_])_([^_]+)_/g,"$1<em>$2</em>")
       .replace(/~~([^~]+)~~/g,"<del>$1</del>")
       .replace(/`([^`]+)`/g,(m,c)=>`<code>${escapeHtml(c)}</code>`);
  // Autolink bare URLs. The leading alternatives swallow existing links, code
  // spans and any other tag first, so the capture group only ever fires on
  // plain text — a URL already inside href="…" is never touched. Trailing
  // sentence punctuation is left out of the link.
  t = t.replace(
    /<a\b[^>]*>[\s\S]*?<\/a>|<code\b[^>]*>[\s\S]*?<\/code>|<[^>]+>|(https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]])/g,
    (m,url)=>url
      ? `<a href="${safeHref(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`
      : m);
  // put the math back: a placeholder §3c fills in, raw TeX as the fallback
  t = t.replace(/\x00M(\d+)\x00/g,(m,i)=>
        `<span class="math-inline" data-tex="${attrValue(maths[i])}">${maths[i]}</span>`)
       .replace(/\x00D\x00/g,"$");
  return t;
}

/* Footnotes. Definitions may sit anywhere in the document but always render as
   a numbered list at the end, so they need a document-wide pass. `fn` holds
   that state: render() is synchronous and only re-enters itself for
   blockquotes, so one context is enough — the outermost call always clears it.
   Labels are word characters only, which keeps the reference (post-escaping)
   and the definition (pre-escaping) spellings identical. */
const FOOTNOTE_DEF=/^\[\^([\w-]+)\]:\s*(.*)$/;
const FOOTNOTE_REF=/\[\^([\w-]+)\]/g;
let fn=null;

function extractFootnotes(lines){
  const defs=new Map(), kept=[];
  for(let i=0;i<lines.length;){
    const m=lines[i].match(FOOTNOTE_DEF);
    if(!m){ kept.push(lines[i]); i++; continue; }
    const parts=[m[2]]; i++;
    while(i<lines.length && /^\s+\S/.test(lines[i])){ parts.push(lines[i].trim()); i++; } // continuation
    defs.set(m[1],parts.join(" ").trim());
  }
  return {defs,kept};
}

// a reference renders only if that label was defined; numbering follows first use
function footnoteRef(label){
  if(!fn || !fn.defs.has(label)) return null;
  let num=fn.used.get(label), first=false;
  if(num===undefined){ num=fn.used.size+1; fn.used.set(label,num); first=true; }
  // only the first reference carries the id, so back-links never point at a duplicate
  return `<sup class="fn-ref"${first?` id="fnref-${num}"`:""} data-fn="${attrValue(label)}">`+
         `<a href="#fn-${num}">${num}</a></sup>`;
}

function footnotesHTML(){
  if(!fn || !fn.used.size) return "";
  const items=[...fn.used.entries()].sort((a,b)=>a[1]-b[1]).map(([label,num])=>{
    const text=fn.defs.get(label);
    // data-fn-src keeps the markdown source, so editing the preview round-trips
    return `<li id="fn-${num}" data-fn="${attrValue(label)}" data-fn-src="${attrValue(escapeHtml(text))}">`+
           `${inline(escapeHtml(text))} `+
           `<a class="fn-back" href="#fnref-${num}" aria-label="Back to reference ${num}">↩</a></li>`;
  }).join("");
  return `<hr class="fn-sep"><ol class="footnotes">${items}</ol>`;
}

const TASK_ITEM=/^\[([ xX])\]\s+(.*)$/;
const isTaskItem=item=>TASK_ITEM.test(item);
const LIST_ITEM=/^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const isOrderedMarker=marker=>/\d/.test(marker);

// one <li> (plus any nested list), rendered as a checkbox for a GFM task item
function listItemHTML(item,sub){
  const m=item.match(TASK_ITEM);
  if(!m) return `<li>${inline(escapeHtml(item))}${sub}</li>`;
  const checked=m[1].toLowerCase()==="x" ? " checked" : "";
  // aria-label: a bare checkbox has no accessible name for screen readers
  const label=attrValue(escapeHtml(m[2].trim() || "Task"));
  return `<li class="task-item"><input type="checkbox"${checked} aria-label="${label}"> `+
         `${inline(escapeHtml(m[2]))}${sub}</li>`;
}

/* One level of a list, recursing into deeper indents; returns [html, nextLine].
   Caller guarantees lines[start] is a list item. Indentation alone decides
   nesting, and switching marker kind (bullet ↔ number) starts a new list. */
function renderList(lines,start){
  const open=lines[start].match(LIST_ITEM);
  const indent=open[1].length;
  const ordered=isOrderedMarker(open[2]);
  const items=[];
  let i=start;
  while(i<lines.length){
    const m=lines[i].match(LIST_ITEM);
    if(!m || m[1].length<indent) break;              // dedent → this level ends
    if(m[1].length>indent){                          // indent → nest under the last item
      if(!items.length) break;
      const [sub,next]=renderList(lines,i);
      items[items.length-1].sub+=sub;
      i=next;
      continue;
    }
    if(isOrderedMarker(m[2])!==ordered) break;
    items.push({text:m[3],sub:""});
    i++;
  }
  const tag=ordered?"ol":"ul";
  const cls=(!ordered && items.some(it=>isTaskItem(it.text))) ? ' class="task-list"' : "";
  return [`<${tag}${cls}>`+items.map(it=>listItemHTML(it.text,it.sub)).join("")+`</${tag}>`, i];
}

function render(src){
  let lines = src
    .replace(/<!--[\s\S]*?-->/g,"")   // HTML comments are hidden, as in real markdown
    .replace(/\r\n?/g,"\n")
    .split("\n");
  // The outermost call owns the footnote context: it lifts every definition out
  // of the flow up front, so a reference resolves even when defined further down.
  const top=fn===null;
  if(top){
    const found=extractFootnotes(lines);
    lines=found.kept;
    fn={defs:found.defs,used:new Map()};
  }
  try{
    return renderLines(lines)+(top?footnotesHTML():"");
  }finally{
    if(top) fn=null;   // never leave a stale context behind, even on a throw
  }
}

function renderLines(lines){
  let html="", i=0;
  while(i<lines.length){
    const line=lines[i];

    // fenced code block. A ```mermaid fence becomes a placeholder that §3b fills
    // in asynchronously — the raw source rides along in data-mmd, and the code
    // block inside is the fallback shown before (or without) the library.
    const fence=line.match(/^```(\S*)/);
    if(fence){
      const code=[]; i++;
      while(i<lines.length && !/^```/.test(lines[i])){ code.push(lines[i]); i++; }
      i++;
      const body=code.join("\n");
      // the info string becomes a language- class for §3d (and for Turndown,
      // which reads it back when the preview is edited); anything that isn't a
      // plain language name is dropped rather than escaped
      const lang=/^[\w+#-]+$/.test(fence[1]) ? fence[1].toLowerCase() : "";
      if(lang==="mermaid")
        html+=`<div class="mermaid-block" data-mmd="${attrValue(escapeHtml(body))}">`+
              `<pre><code>${escapeHtml(body)}</code></pre></div>`;
      else
        html+=`<pre><code${lang?` class="language-${lang}"`:""}>${escapeHtml(body)}</code></pre>`;
      continue;
    }
    // display math: $$…$$ on one line, or a $$-fenced block over several
    const dm=line.match(/^\s*\$\$(.*)$/);
    if(dm){
      let body;
      const close=dm[1].indexOf("$$");
      if(close!==-1){ body=dm[1].slice(0,close); i++; }
      else{
        const tex=[dm[1]]; i++;
        while(i<lines.length && !/^\s*\$\$\s*$/.test(lines[i])){ tex.push(lines[i]); i++; }
        i++;
        body=tex.join("\n").trim();
      }
      html+=`<div class="math-block" data-tex="${attrValue(escapeHtml(body))}">`+
            `<code>${escapeHtml(body)}</code></div>`;
      continue;
    }
    // Raw HTML block: a lone tag (<div align="center">) or one complete element
    // on its own line (<summary>Details</summary>). Passed through verbatim;
    // sanitize() scrubs it before it reaches the DOM.
    if(/^\s*<\/?[a-zA-Z][^>]*>\s*$/.test(line) ||
       /^\s*<([a-zA-Z][\w-]*)\b[^>]*>.*<\/\1>\s*$/.test(line)){
      html+=line; i++; continue;
    }
    // heading
    const h=line.match(/^(#{1,6})\s+(.*)$/);
    if(h){ html+=`<h${h[1].length}>${inline(escapeHtml(h[2]))}</h${h[1].length}>`; i++; continue; }
    // horizontal rule
    if(/^(\s*[-*_]){3,}\s*$/.test(line)){ html+="<hr>"; i++; continue; }
    // blockquote (collect consecutive lines)
    if(/^>\s?/.test(line)){
      const q=[];
      while(i<lines.length && /^>\s?/.test(lines[i])){ q.push(lines[i].replace(/^>\s?/,"")); i++; }
      html+=`<blockquote>${render(q.join("\n"))}</blockquote>`;
      continue;
    }
    // table
    if(/^\s*\|.*\|\s*$/.test(line) && i+1<lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i+1])){
      const parseRow=r=>r.trim().replace(/^\||\|$/g,"").split("|").map(c=>c.trim());
      // the delimiter row carries per-column alignment: :--- ---: :---:
      const align=parseRow(lines[i+1]).map(d=>{
        const l=d.startsWith(":"), r=d.endsWith(":");
        return l&&r ? ' align="center"' : r ? ' align="right"' : l ? ' align="left"' : "";
      });
      const cell=(tag,c,n)=>`<${tag}${align[n]||""}>${inline(escapeHtml(c))}</${tag}>`;
      const head=parseRow(line); i+=2; let body="";
      while(i<lines.length && /^\s*\|.*\|\s*$/.test(lines[i])){
        body+="<tr>"+parseRow(lines[i]).map((c,n)=>cell("td",c,n)).join("")+"</tr>"; i++;
      }
      html+=`<table><thead><tr>${head.map((c,n)=>cell("th",c,n)).join("")}</tr></thead>`+
            `<tbody>${body}</tbody></table>`;
      continue;
    }
    // list — bullet or numbered, nested by indentation, GFM task items
    if(LIST_ITEM.test(line)){
      const [listHtml,next]=renderList(lines,i);
      html+=listHtml; i=next;
      continue;
    }
    if(/^\s*$/.test(line)){ i++; continue; }
    // paragraph (collect until blank line or a block start)
    const para=[];
    while(i<lines.length && !/^\s*$/.test(lines[i]) &&
          !/^(#{1,6}\s|>|\s*[-*+]\s|\s*\d+\.\s|```|\s*\$\$|(\s*[-*_]){3,}\s*$)/.test(lines[i])){
      para.push(lines[i]); i++;
    }
    html+=`<p>${inline(escapeHtml(para.join("\n"))).replace(/\n/g,"<br>")}</p>`;
  }
  return html;
}

/* Raw HTML from the document reaches the DOM, so scrub it first: keep a
   known-good tag/attribute set and drop anything that could execute. */
const ALLOWED_TAGS=new Set(["a","abbr","b","blockquote","br","caption","code","dd","del",
  "details","div","dl","dt","em","figcaption","figure","h1","h2","h3","h4","h5","h6","hr",
  "i","img","input","ins","kbd","li","mark","ol","p","picture","pre","q","s","samp","small",
  "source","span","strong","sub","summary","sup","table","tbody","td","tfoot","th","thead",
  "tr","u","ul","var"]);
const ALLOWED_ATTRS=new Set(["align","alt","checked","class","colspan","dir","disabled",
  "height","href","open","rel","rowspan","span","src","srcset","start","target","title",
  "type","width",
  "data-mmd",    // inert diagram source for §3b — carries no executable surface
  "data-tex",    // inert math source for §3c — same story
  "data-fn","data-fn-src", // footnote label + markdown source, for the round trip
  "id",          // footnote anchors only — see FOOTNOTE_ANCHOR below
  "aria-label"]); // plain text for screen readers; the renderer puts it on checkboxes
/* An arbitrary id from a document could shadow one of the app's own elements in
   a later getElementById lookup, so only the ids this renderer generates survive. */
const FOOTNOTE_ANCHOR=/^fn(ref)?-\d+$/;
const domParser=new DOMParser();

function sanitize(html){
  const doc=domParser.parseFromString(html,"text/html");
  for(const el of doc.body.querySelectorAll("*")){
    const tag=el.tagName.toLowerCase();
    if(tag==="script"||tag==="style"){ el.remove(); continue; }
    if(!ALLOWED_TAGS.has(tag)){ el.replaceWith(...el.childNodes); continue; } // unwrap, keep text
    for(const attr of [...el.attributes]){
      const name=attr.name.toLowerCase();
      if(!ALLOWED_ATTRS.has(name)){ el.removeAttribute(attr.name); continue; } // kills on* handlers
      if(name==="id" && !FOOTNOTE_ANCHOR.test(attr.value)) el.removeAttribute("id");
      if(name==="href" && UNSAFE_SCHEME.test(attr.value)) el.setAttribute("href","#");
      if(name==="src" && !/^\s*data:image\//i.test(attr.value) && UNSAFE_SCHEME.test(attr.value))
        el.removeAttribute("src");
    }
  }
  return doc.body.innerHTML;
}

/* ============================================================
   2. UI helpers — toast + confirm modal
   ============================================================ */
function toast(msg,isErr){
  // hammering the same action must not stack copies — one of each message at a time
  for(const existing of toastHost.children)
    if(existing.textContent===msg) return;
  const t=document.createElement("div");
  t.className="toast"+(isErr?" err":"");
  t.textContent=msg;
  toastHost.appendChild(t);
  setTimeout(()=>{ t.classList.add("out"); setTimeout(()=>t.remove(),250); },2200);
}

/* Every dialog shares the same shell: a backdrop, Escape and click-outside to
   dismiss, Enter to confirm, and Tab cycling trapped inside. Callers supply only
   the body markup, how to read a result, and what to focus. */
function openModal({body,okLabel="OK",cancelValue,readResult,onOpen}){
  return new Promise(resolve=>{
    const back=document.createElement("div");
    back.className="modal-backdrop";
    back.innerHTML=`<div class="modal">${body}<div class="actions">`+
      `<button class="cancel">Cancel</button>`+
      `<button class="primary">${okLabel}</button></div></div>`;
    document.body.appendChild(back);

    const close=v=>{ back.remove(); document.removeEventListener("keydown",onKey); resolve(v); };
    const cancel=()=>close(cancelValue);
    const confirm=()=>close(readResult(back));
    const onKey=e=>{
      if(e.key==="Escape"){ cancel(); return; }
      if(e.key==="Enter"){
        // Enter on the Cancel button should cancel, not confirm
        if(document.activeElement && document.activeElement.classList.contains("cancel")) cancel();
        else { e.preventDefault(); confirm(); }
        return;
      }
      if(e.key==="Tab"){ // keep focus inside the dialog
        const f=[...back.querySelectorAll("input,button")];
        const idx=f.indexOf(document.activeElement);
        e.preventDefault();
        f[(idx + (e.shiftKey?-1:1) + f.length) % f.length].focus();
      }
    };
    back.querySelector(".cancel").onclick=cancel;
    back.querySelector(".primary").onclick=confirm;
    back.onclick=e=>{ if(e.target===back)cancel(); };
    document.addEventListener("keydown",onKey);
    onOpen(back);
  });
}

function confirmModal(message,okLabel){
  return openModal({
    body:"<p></p>",
    okLabel:okLabel||"OK",
    cancelValue:false,
    readResult:()=>true,
    onOpen:back=>{
      back.querySelector("p").textContent=message; // textContent: never inject
      back.querySelector(".primary").focus();
    },
  });
}

function promptModal(message,defaultValue,okLabel){
  return openModal({
    body:`<p></p><input class="modal-input" type="text" dir="ltr">`,
    okLabel:okLabel||"OK",
    cancelValue:null,
    readResult:back=>back.querySelector(".modal-input").value.trim() || null,
    onOpen:back=>{
      back.querySelector("p").textContent=message; // textContent: never inject
      const input=back.querySelector(".modal-input");
      input.value=defaultValue||"";
      input.focus();
      input.select();
    },
  });
}

const MAX_TABLE_COLS=20, MAX_TABLE_ROWS=50;
function tableSizeModal(){
  const clamp=(el,max)=>Math.min(max,Math.max(1,parseInt(el.value,10)||1));
  return openModal({
    body:`<p>Insert table</p><div class="table-fields">`+
      `<label>Columns<input class="modal-input" type="number" min="1" max="${MAX_TABLE_COLS}" value="3"></label>`+
      `<label>Rows<input class="modal-input" type="number" min="1" max="${MAX_TABLE_ROWS}" value="3"></label>`+
      `</div>`,
    okLabel:"Insert",
    cancelValue:null,
    readResult:back=>{
      const [colsIn,rowsIn]=back.querySelectorAll("input");
      return {cols:clamp(colsIn,MAX_TABLE_COLS),rows:clamp(rowsIn,MAX_TABLE_ROWS)};
    },
    onOpen:back=>{ const cols=back.querySelector("input"); cols.focus(); cols.select(); },
  });
}

/* ============================================================
   3. State & elements
   ============================================================ */
const editor    = document.getElementById("editor");
const preview   = document.getElementById("preview");
const main      = document.querySelector(".main");
const divider   = document.getElementById("divider");
const editPane  = document.querySelector(".edit-pane");
const header    = document.querySelector("header");
const toastHost = document.getElementById("toasts");
const statWords = document.getElementById("stat-words");
const statChars = document.getElementById("stat-chars");

const KEY       = "md-editor-content";
const THEME_KEY = "md-editor-theme";
const DIR_KEY   = "md-editor-dir";
const SPLIT_KEY = "md-editor-split";
const SYNC_KEY  = "md-editor-sync";

const SAMPLE=`# Welcome to MD Editor

A **simple**, fast markdown editor that runs entirely in your browser — no build step, no server, nothing to install.

## Features
- **Live preview** as you type — and the preview is editable too
- **Formatting toolbar** — select text or right-click inside the preview
- **Find & replace** with \`Ctrl+F\`
- **Checklists**, tables, code blocks, quotes and images
- **Syntax highlighting** — name a language on a code fence
- **Mermaid diagrams** — put one in a \`\`\`mermaid code block
- **LaTeX math** — inline \$e^{i\\pi}+1=0\$ or full display equations
- **Reading mode** — just your document, distraction-free (Esc to leave)
- **Dark / light** themes and **RTL / LTR** text direction
- **Resizable panes** — drag the divider, double-click to reset
- **Sync scroll** between the editor and the preview
- **Copy** as Markdown, HTML or plain text
- **Export** as HTML, PDF or Markdown — or drag a \`.md\` file in to open it
- **Autosaves** to your browser as you write

## To-do
- [x] Write in markdown
- [ ] Try the checklist
  - [ ] Indent with Tab to nest an item
- [ ] Press Ctrl+F to find & replace

> Tip: press Enter inside a list and the next item continues automatically.

\`\`\`js
console.log("Hello, markdown!");
\`\`\`

\`\`\`mermaid
graph LR
  A[Write markdown] --> B(Live preview)
  B --> C{Happy?}
  C -->|yes| D[Export PDF]
  C -->|no| A
\`\`\`

$$\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}$$

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd + S | Save as .md |
| Ctrl/Cmd + F | Find & replace |
| Ctrl/Cmd + Z | Undo |
`;

/* ============================================================
   3b. Mermaid diagrams — lazy ESM import, drawn after sanitize
   ============================================================ */
/* The renderer emits a .mermaid-block placeholder (source in data-mmd, plain
   code block as fallback). The library is imported only once a document
   actually contains a diagram — a doc without one costs zero bytes. Its SVG
   is injected AFTER sanitize() ran, so the allowlist never has to admit SVG
   tags; safety inside the SVG is mermaid's securityLevel:"strict".
   This section sits before update() because update() calls the scheduler. */
const MERMAID_ESM="https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs";
let mermaidPromise=null, mermaidWarned=false, mermaidTimer=null, mermaidRun=0, mermaidSeq=0;
const mermaidCache=new Map();   // diagram source -> rendered SVG markup

function isDarkTheme(){ return document.documentElement.getAttribute("data-theme")==="dark"; }
function mermaidTheme(){ return isDarkTheme() ? "dark" : "default"; }
function mermaidInit(m,themeOverride){
  m.initialize({
    startOnLoad:false,
    securityLevel:"strict",       // labels escaped; scripts and click bindings blocked
    suppressErrorRendering:true,  // errors go to our catch, not into the document
    theme:themeOverride||mermaidTheme(),
  });
}
function ensureMermaid(){
  if(!mermaidPromise){
    mermaidPromise=import(MERMAID_ESM).then(mod=>{ mermaidInit(mod.default); return mod.default; });
    mermaidPromise.catch(()=>{ mermaidPromise=null; }); // failed load may be retried later
  }
  return mermaidPromise;
}

/* render() measures text in a temp <div> that mermaid appends to <body> by
   default. Our <body> is a column flexbox, so that div becomes a flex item and
   shoves the footer up until the render finishes. Hand render() a host that is
   position:fixed instead: out of the document flow (nothing moves) but still
   laid out (unlike display:none), so text measurement keeps working. */
let mermaidHost=null;
function mermaidRenderHost(){
  if(!mermaidHost){
    mermaidHost=document.createElement("div");
    mermaidHost.style.cssText="position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none";
    document.body.appendChild(mermaidHost);
  }
  return mermaidHost;
}

async function renderMermaidBlocks(){
  const run=++mermaidRun;
  const blocks=preview.querySelectorAll(".mermaid-block");
  if(!blocks.length) return;
  let m;
  try{ m=await ensureMermaid(); }
  catch{
    if(!mermaidWarned){
      mermaidWarned=true;
      toast("Couldn't load the diagram engine — check your connection",true);
    }
    return; // the fallback code block stays visible
  }
  for(const block of blocks){
    if(run!==mermaidRun) return;  // a newer render pass took over; its blocks are fresher
    const src=block.dataset.mmd || "";
    const cached=mermaidCache.get(src);
    if(cached!==undefined){ block.innerHTML=cached; continue; }
    try{
      const {svg}=await m.render("mmd-"+(++mermaidSeq),src,mermaidRenderHost());
      if(mermaidCache.size>100) mermaidCache.clear(); // crude cap; sources are tiny anyway
      mermaidCache.set(src,svg);
      if(run===mermaidRun) block.innerHTML=svg;
    }catch(err){
      // syntax error → clean message + the source, instead of mermaid's error art
      const msg=document.createElement("div");
      msg.className="mermaid-error";
      msg.textContent="Diagram error: "+String(err && err.message || err).split("\n")[0];
      const pre=document.createElement("pre");
      const code=document.createElement("code");
      code.textContent=src;
      pre.appendChild(code);
      block.replaceChildren(msg,pre);
    }
  }
}

function scheduleMermaidRender(){
  const blocks=preview.querySelectorAll(".mermaid-block");
  if(!blocks.length) return;
  // Lock the blocks immediately (not after the debounce): typing inside one in
  // the preview would let Turndown turn the rendered SVG into garbage — the
  // markdown source is the only editable form of a diagram.
  blocks.forEach(b=>b.setAttribute("contenteditable","false"));
  clearTimeout(mermaidTimer);
  mermaidTimer=setTimeout(renderMermaidBlocks,300);
}

// Theme switch: mermaid bakes colours into the SVG, so re-init and redraw.
function rethemeMermaid(){
  if(!mermaidPromise) return; // nothing was ever drawn
  mermaidPromise.then(m=>{
    mermaidInit(m);
    mermaidCache.clear();
    renderMermaidBlocks();
  }).catch(()=>{});
}

/* ============================================================
   3c. LaTeX math — KaTeX, same lazy pattern as the diagrams
   ============================================================ */
/* The renderer emits .math-inline / .math-block placeholders (TeX source in
   data-tex, the raw TeX as visible fallback). KaTeX + its stylesheet load only
   once a document actually contains math. Its output is injected AFTER
   sanitize(), so the allowlist stays closed. */
const KATEX_VER="0.18.1";
const KATEX_JS ="https://cdn.jsdelivr.net/npm/katex@"+KATEX_VER+"/dist/katex.min.js";
const KATEX_CSS="https://cdn.jsdelivr.net/npm/katex@"+KATEX_VER+"/dist/katex.min.css";
let katexPromise=null, katexWarned=false, katexTimer=null;
const katexCache=new Map();     // "d:"/"i:" + tex → rendered HTML

function ensureKatex(){
  if(!katexPromise){
    const css=document.createElement("link");
    css.rel="stylesheet";
    css.href=KATEX_CSS;
    document.head.appendChild(css);
    katexPromise=loadScript(KATEX_JS).then(()=>window.katex);
    katexPromise.catch(()=>{ katexPromise=null; }); // failed load may be retried
  }
  return katexPromise;
}

async function renderMathEls(){
  const els=preview.querySelectorAll(".math-inline,.math-block");
  if(!els.length) return;
  let k;
  try{ k=await ensureKatex(); }
  catch{
    if(!katexWarned){
      katexWarned=true;
      toast("Couldn't load the math engine — check your connection",true);
    }
    return; // the raw-TeX fallback stays visible
  }
  for(const el of els){
    const tex=el.dataset.tex || "";
    const display=el.classList.contains("math-block");
    const key=(display?"d:":"i:")+tex;
    let out=katexCache.get(key);
    if(out===undefined){
      // throwOnError:false renders bad TeX in red instead of breaking the pass
      out=k.renderToString(tex,{displayMode:display,throwOnError:false,errorColor:"#f85149"});
      if(katexCache.size>300) katexCache.clear();
      katexCache.set(key,out);
    }
    el.innerHTML=out;
  }
}

function scheduleMathRender(){
  const els=preview.querySelectorAll(".math-inline,.math-block");
  if(!els.length) return;
  // lock immediately, like the diagrams: Turndown must never see edited KaTeX
  // markup — data-tex is the only editable form of a formula
  els.forEach(el=>el.setAttribute("contenteditable","false"));
  clearTimeout(katexTimer);
  katexTimer=setTimeout(renderMathEls,300);
}

/* ============================================================
   3d. Code syntax highlighting — highlight.js, lazy like the rest
   ============================================================ */
/* Only fenced blocks that named a language are touched, and the library is
   fetched the first time one appears. highlight.js escapes its own output, so
   injecting it straight into the block is safe — same trust model as the
   diagram SVG and the KaTeX markup. Colours live entirely in its stylesheet:
   the screen sheet follows the app theme, and a second sheet pinned to
   media="print" keeps exported pages readable without any swap at print time. */
const HLJS_BASE="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1";
const hljsThemeUrl=dark=>HLJS_BASE+"/styles/github"+(dark?"-dark":"")+".min.css";
const CODE_SELECTOR='pre code[class*="language-"]';
let hljsPromise=null, hljsWarned=false, hljsTimer=null, hljsLink=null;
const hljsCache=new Map();   // "lang\0source" → highlighted HTML

function ensureHljs(){
  if(!hljsPromise){
    hljsLink=document.createElement("link");
    hljsLink.rel="stylesheet";
    hljsLink.media="screen";
    hljsLink.href=hljsThemeUrl(isDarkTheme());
    const printSheet=document.createElement("link");
    printSheet.rel="stylesheet";
    printSheet.media="print";
    printSheet.href=hljsThemeUrl(false);
    document.head.append(hljsLink,printSheet);
    hljsPromise=loadScript(HLJS_BASE+"/highlight.min.js").then(()=>window.hljs);
    hljsPromise.catch(()=>{ hljsPromise=null; }); // failed load may be retried
  }
  return hljsPromise;
}

async function highlightCode(){
  const blocks=preview.querySelectorAll(CODE_SELECTOR);
  if(!blocks.length) return;
  let h;
  try{ h=await ensureHljs(); }
  catch{
    if(!hljsWarned){
      hljsWarned=true;
      toast("Couldn't load the syntax highlighter — check your connection",true);
    }
    return; // code stays readable, just uncoloured
  }
  for(const el of blocks){
    const lang=(el.className.match(/language-([\w+#-]+)/)||[])[1];
    if(!lang || !h.getLanguage(lang)) continue;   // unknown language → leave it plain
    const code=el.textContent;
    const key=lang+"\0"+code;
    let out=hljsCache.get(key);
    if(out===undefined){
      out=h.highlight(code,{language:lang,ignoreIllegals:true}).value;
      if(hljsCache.size>200) hljsCache.clear();
      hljsCache.set(key,out);
    }
    el.innerHTML=out;
    el.classList.add("hljs");
  }
}

function scheduleHighlight(){
  if(!preview.querySelector(CODE_SELECTOR)) return;
  clearTimeout(hljsTimer);
  hljsTimer=setTimeout(highlightCode,300);
}

// theme switch only moves the screen sheet; the print sheet stays light
function rethemeHljs(){ if(hljsLink) hljsLink.href=hljsThemeUrl(isDarkTheme()); }

/* ============================================================
   4. Live render / autosave
   ============================================================ */
function updateStats(text){
  const words=(text.trim().match(/\S+/g)||[]).length;
  statWords.textContent=words+" words";
  statChars.textContent=text.length+" chars";
}

/* localStorage writes are synchronous, so debounce them instead of writing on
   every keystroke. Flushed on hide/unload so nothing is ever lost. */
let saveTimer=null, pendingSave=null;
function persist(text){
  pendingSave=text;
  clearTimeout(saveTimer);
  saveTimer=setTimeout(flushSave,300);
}
function flushSave(){
  clearTimeout(saveTimer);
  if(pendingSave!==null){ localStorage.setItem(KEY,pendingSave); pendingSave=null; }
}
window.addEventListener("pagehide",flushSave);
document.addEventListener("visibilitychange",()=>{ if(document.hidden) flushSave(); });

function update(){
  const v=editor.value;
  preview.innerHTML=sanitize(render(v));
  // the footnote list is generated, not authored — editing it would only
  // confuse the round trip, so lock it like the diagrams and formulas
  preview.querySelectorAll(".footnotes,.fn-sep")
         .forEach(el=>el.setAttribute("contenteditable","false"));
  scheduleMermaidRender();
  scheduleMathRender();
  scheduleHighlight();
  persist(v);
  updateStats(v);
}

editor.value = localStorage.getItem(KEY) ?? SAMPLE;
if(localStorage.getItem(THEME_KEY))
  document.documentElement.setAttribute("data-theme",localStorage.getItem(THEME_KEY));
update();

editor.addEventListener("input",update);

/* ============================================================
   5. Editable preview (WYSIWYG → markdown via Turndown)
   ============================================================ */
preview.contentEditable="true";
preview.spellcheck=false;

/* Third-party libraries are fetched the first time they're actually needed,
   never on page load — first paint owes the network nothing but this file. */
const CDN={
  turndown:    "https://cdn.jsdelivr.net/npm/turndown@7.2.0/dist/turndown.min.js",
  turndownGfm: "https://cdn.jsdelivr.net/npm/turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.min.js",
};
const scriptPromises=new Map();
function loadScript(src){
  if(scriptPromises.has(src)) return scriptPromises.get(src);
  const p=new Promise((resolve,reject)=>{
    const s=document.createElement("script");
    s.src=src;
    s.onload=resolve;
    s.onerror=()=>reject(new Error("failed to load "+src));
    document.head.appendChild(s);
  });
  scriptPromises.set(src,p);
  return p;
}
function ensureTurndown(){
  if(typeof TurndownService!=="undefined") return Promise.resolve();
  return loadScript(CDN.turndown).then(()=>loadScript(CDN.turndownGfm));
}

let turndownSvc=null;
function getTurndown(){
  if(turndownSvc) return turndownSvc;
  if(typeof TurndownService==="undefined") return null;
  turndownSvc=new TurndownService({
    headingStyle:"atx",
    codeBlockStyle:"fenced",
    bulletListMarker:"-",
    emDelimiter:"*"
  });
  if(window.turndownPluginGfm) turndownSvc.use(window.turndownPluginGfm.gfm);
  // A rendered diagram round-trips via its data-mmd source — never its SVG,
  // which Turndown would otherwise mangle into plain text.
  turndownSvc.addRule("mermaid",{
    filter:node=>node.nodeType===1 && node.classList.contains("mermaid-block"),
    replacement:(_,node)=>"\n\n```mermaid\n"+(node.getAttribute("data-mmd")||"")+"\n```\n\n"
  });
  /* Footnotes: references go back to [^label], the generated list back to the
     definition lines it came from, and the separator and back-links vanish. */
  turndownSvc.addRule("footnoteRef",{
    filter:node=>node.nodeType===1 && node.classList.contains("fn-ref"),
    replacement:(_,node)=>"[^"+(node.getAttribute("data-fn")||"1")+"]"
  });
  turndownSvc.addRule("footnoteList",{
    filter:node=>node.nodeType===1 && node.classList.contains("footnotes"),
    replacement:(_,node)=>"\n\n"+[...node.children]
      .map(li=>"[^"+(li.getAttribute("data-fn")||"1")+"]: "+(li.getAttribute("data-fn-src")||""))
      .join("\n")+"\n\n"
  });
  turndownSvc.addRule("footnoteChrome",{
    filter:node=>node.nodeType===1 &&
      (node.classList.contains("fn-sep") || node.classList.contains("fn-back")),
    replacement:()=>""
  });
  // formulas round-trip via data-tex, never via KaTeX's rendered markup
  turndownSvc.addRule("math",{
    filter:node=>node.nodeType===1 &&
      (node.classList.contains("math-inline") || node.classList.contains("math-block")),
    replacement:(_,node)=>{
      const tex=node.getAttribute("data-tex")||"";
      return node.classList.contains("math-block")
        ? "\n\n$$\n"+tex+"\n$$\n\n"
        : "$"+tex+"$";
    }
  });
  return turndownSvc;
}

/* One action can trigger several sync calls (execCommand fires `input`, and the
   caller syncs explicitly too), so collapse repeat warnings into one toast. */
let engineWarnedAt=0;
function warnEngineFailed(){
  const now=Date.now();
  if(now-engineWarnedAt<2500) return; // a toast lives ~2.2s — don't stack duplicates
  engineWarnedAt=now;
  toast("Couldn't load the editor engine — check your connection",true);
}

// `retried` guards against looping if the script loads but doesn't define the global
function syncPreviewToMarkdown(retried){
  const td=getTurndown();
  if(!td){
    if(retried){ warnEngineFailed(); return; }
    ensureTurndown().then(()=>syncPreviewToMarkdown(true)).catch(warnEngineFailed);
    return;
  }
  // innerHTML serializes ATTRIBUTES, but ticking a box only flips the PROPERTY —
  // mirror it onto the attribute so the checked state survives serialization
  preview.querySelectorAll('input[type="checkbox"]')
         .forEach(cb=>cb.toggleAttribute("checked",cb.checked));
  const md=td.turndown(preview.innerHTML);
  editor.value=md;
  persist(md);
  // update counts WITHOUT re-rendering the preview (keeps the caret in place)
  updateStats(md);
}
// wrapped, not passed directly: the listener's Event arg would be read as `retried`
preview.addEventListener("input",()=>syncPreviewToMarkdown());
// clicking a task-list checkbox toggles it → reflect the change back into markdown
preview.addEventListener("change",e=>{
  if(!e.target.matches('input[type="checkbox"]')) return;
  if(isReading()){ e.target.checked=!e.target.checked; return; } // read-only
  syncPreviewToMarkdown();
});
// warm the converter as soon as the user aims at the preview, so the first
// keystroke doesn't have to wait for the network
["pointerdown","focusin"].forEach(ev=>
  preview.addEventListener(ev,()=>{ ensureTurndown().catch(()=>{}); },{once:true}));

/* Links inside contenteditable lose all their native behaviour (click,
   middle-click, hover status bar) — rebuild each. Edits to a link's text
   belong on the markdown side. */
function linkHrefAt(target){
  const a=target.closest("a");
  const href=a && a.getAttribute("href");
  return (href && href!=="#") ? href : null;   // "#" = neutered by sanitize()
}
function openLink(e){
  const href=linkHrefAt(e.target);
  if(!href) return;
  e.preventDefault();
  if(href.startsWith("#")){   // in-page anchor (footnotes) — scroll, don't open a tab
    const id=href.slice(1);
    const target=[...preview.querySelectorAll("[id]")].find(el=>el.id===id);
    if(target) target.scrollIntoView({behavior:"smooth",block:"center"});
    return;
  }
  window.open(href,"_blank","noopener");
}
preview.addEventListener("click",openLink);
preview.addEventListener("auxclick",e=>{ if(e.button===1) openLink(e); });
// middle-pressing a link must not start the browser's autoscroll mode
preview.addEventListener("mousedown",e=>{
  if(e.button===1 && linkHrefAt(e.target)) e.preventDefault();
});

// Hover-URL status bar, like the browser's own (also suppressed in contenteditable)
const linkStatus=document.getElementById("linkStatus");
preview.addEventListener("mouseover",e=>{
  const href=linkHrefAt(e.target);
  if(href){ linkStatus.textContent=href; linkStatus.hidden=false; }
  else linkStatus.hidden=true;
});
preview.addEventListener("mouseleave",()=>{ linkStatus.hidden=true; });

function placeCaretAtEnd(node){
  const r=document.createRange();
  r.selectNodeContents(node);
  r.collapse(false);
  const s=window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
}
function taskItemAtCaret(){
  let node=window.getSelection().anchorNode;
  while(node && node!==preview){
    if(node.nodeType===1 && node.nodeName==="LI" &&
       node.querySelector(':scope > input[type="checkbox"]')) return node;
    node=node.parentNode;
  }
  return null;
}
// Enter inside a task item must produce another task item — the browser's default
// makes a plain <li> with no checkbox. An empty item ends the list instead.
preview.addEventListener("keydown",e=>{
  if(e.key!=="Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  const li=taskItemAtCaret();
  if(!li) return;
  e.preventDefault();
  if(li.textContent.trim()===""){          // empty item → leave the list
    const ul=li.parentNode;
    const p=document.createElement("p");
    p.appendChild(document.createElement("br"));
    ul.parentNode.insertBefore(p,ul.nextSibling);
    li.remove();
    if(!ul.children.length) ul.remove();
    placeCaretAtEnd(p);
  }else{                                    // otherwise → a fresh unchecked item
    const item=document.createElement("li");
    item.className="task-item";
    const cb=document.createElement("input");
    cb.type="checkbox";
    cb.setAttribute("aria-label","Task");
    item.append(cb," ");
    li.parentNode.insertBefore(item,li.nextSibling);
    placeCaretAtEnd(item);
  }
  syncPreviewToMarkdown();
});

/* ============================================================
   6. Keyboard shortcuts
   ============================================================ */
// insert / delete in an UNDOABLE way (execCommand keeps Ctrl+Z history intact)
function typeText(text){ editor.focus(); document.execCommand("insertText",false,text); }
function deleteRange(a,b){ editor.focus(); editor.setSelectionRange(a,b); document.execCommand("delete"); }

// Enter continues the current markdown list; on an empty item it ends the list
function continueList(){
  if(editor.selectionStart!==editor.selectionEnd) return false; // has a selection → normal Enter
  const val=editor.value, pos=editor.selectionStart;
  const lineStart=val.lastIndexOf("\n",pos-1)+1;
  const nl=val.indexOf("\n",pos);
  const lineEnd=nl===-1?val.length:nl;
  const line=val.slice(lineStart,lineEnd);
  let m, marker, empty;
  if((m=line.match(/^(\s*)([-*+])\s+\[[ xX]\]\s+(.*)$/))){ marker=m[1]+m[2]+" [ ] "; empty=m[3].trim()===""; }
  else if((m=line.match(/^(\s*)([-*+])\s+(.*)$/))){ marker=m[1]+m[2]+" "; empty=m[3].trim()===""; }
  else if((m=line.match(/^(\s*)(\d+)\.\s+(.*)$/))){ marker=m[1]+(parseInt(m[2],10)+1)+". "; empty=m[3].trim()===""; }
  else return false;
  if(empty) deleteRange(lineStart,lineEnd); // empty item → drop the marker, end the list
  else typeText("\n"+marker);
  return true; // execCommand fires `input`, which re-renders via update()
}

editor.addEventListener("keydown",e=>{
  if(e.key==="Tab"){ e.preventDefault(); typeText("  "); }
  else if(e.key==="Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey){
    if(continueList()) e.preventDefault();
  }
});

// Ctrl/Cmd+S is global: with focus in the preview it would otherwise fall through
// to the browser's own "Save page as…", which writes an .html file.
document.addEventListener("keydown",e=>{
  if((e.ctrlKey||e.metaKey) && (e.code==="KeyS" || e.key==="s" || e.key==="S")){
    e.preventDefault();
    save();
  }
});

/* ============================================================
   7. Save / Open files
   ============================================================ */
function downloadBlob(name,blob){
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=name;
  a.click();
  URL.revokeObjectURL(a.href);
}
function save(){
  downloadBlob("document.md",new Blob([editor.value],{type:"text/markdown"}));
  toast("Saved document.md");
}

function loadFile(file){
  const r=new FileReader();
  r.onload=()=>{ editor.value=r.result; update(); toast("Imported "+file.name); };
  r.onerror=()=>toast("Couldn't read "+file.name,true);
  r.readAsText(file);
}
document.getElementById("openBtn").onclick=()=>document.getElementById("fileInput").click();
document.getElementById("fileInput").onchange=e=>{
  const f=e.target.files[0]; if(f) loadFile(f);
};

document.getElementById("clearBtn").onclick=async()=>{
  if(!editor.value){ editor.focus(); return; }
  if(await confirmModal("Clear the editor? You can undo with Ctrl+Z.","Clear")){
    editor.focus();
    editor.select();
    // execCommand keeps the native undo history, so Ctrl+Z restores the text
    const ok=document.execCommand("delete");
    if(!ok||editor.value){ editor.value=""; update(); } // fallback: clears, but no undo
    toast("Cleared — press Ctrl+Z to undo");
  }
};

/* ============================================================
   8. Export menu — HTML / PDF / Markdown
   ============================================================ */
const exportMenu=document.getElementById("exportMenu");
document.getElementById("exportBtn").onclick=e=>{
  e.stopPropagation();
  copyMenu.classList.remove("open");   // only one menu open at a time
  exportMenu.classList.toggle("open");
};
document.addEventListener("click",()=>exportMenu.classList.remove("open"));
exportMenu.querySelectorAll("[data-export]").forEach(btn=>{
  btn.onclick=()=>{
    exportMenu.classList.remove("open");
    if(btn.dataset.export==="md") save();
    else if(btn.dataset.export==="html") exportHtml();
    else exportPdf();
  };
});

/* Exports land on white pages, but in dark mode the diagrams were drawn with
   the dark mermaid theme (pale strokes, light text) — unreadable there.
   Redraws them light and returns a restore function for the caller's finally. */
async function lightenDiagramsForExport(){
  const needed=mermaidTheme()==="dark" && mermaidPromise && preview.querySelector(".mermaid-block");
  if(needed){
    try{
      mermaidInit(await mermaidPromise,"default");
      mermaidCache.clear();
      await renderMermaidBlocks();
    }catch{ /* diagrams just keep their dark colours */ }
  }
  return ()=>{ if(needed) rethemeMermaid(); };
}

// Standalone .html file: the rendered preview plus a small self-contained
// stylesheet. Light theme — a document is usually read on a white page.
async function exportHtml(){
  const restoreDiagrams=await lightenDiagramsForExport();
  const body=preview.innerHTML;
  restoreDiagrams();
  const title=escapeHtml((editor.value.match(/^#\s+(.+)$/m)||[])[1] || "Document");
  // KaTeX and highlight.js markup carry no colours of their own — link their
  // stylesheets (the light ones, for a document read on white) only when used
  const mathCss=preview.querySelector(".math-inline,.math-block")
    ? `\n<link rel="stylesheet" href="${KATEX_CSS}">` : "";
  const codeCss=preview.querySelector("pre code.hljs")
    ? `\n<link rel="stylesheet" href="${hljsThemeUrl(false)}">` : "";
  const doc=`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>${mathCss}${codeCss}
<style>
body{max-width:800px;margin:2rem auto;padding:0 16px;color:#1f2328;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;line-height:1.6}
h1,h2{border-bottom:1px solid #d0d7de;padding-bottom:.3em}
code{background:#f6f8fa;border:1px solid #d0d7de;border-radius:4px;padding:.15em .4em;
  font-family:ui-monospace,Consolas,monospace;font-size:85%}
pre{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:14px;overflow-x:auto}
pre code{border:none;padding:0;background:none}
blockquote{margin:0;padding:0 1em;color:#656d76;border-left:3px solid #d0d7de}
table{border-collapse:collapse}
th,td{border:1px solid #d0d7de;padding:6px 12px}
img,svg{max-width:100%}
a{color:#0969da}
hr{border:none;border-top:1px solid #d0d7de}
ul.task-list{list-style:none;padding-left:.3em}
li.task-item{list-style:none}
.mermaid-block,.math-block{margin:1em 0;text-align:center;overflow-x:auto}
.fn-sep{margin-top:2.5em}
.footnotes{font-size:.9em;color:#656d76}
sup.fn-ref a,.fn-back{text-decoration:none}
.fn-back{margin-left:4px}
.mermaid-error{color:#d1242f;font-size:13px;text-align:left}
</style>
</head>
<body>
${body}
</body>
</html>`;
  downloadBlob("document.html",new Blob([doc],{type:"text/html"}));
  toast("Saved document.html");
}

/* PDF via the browser's own print engine (the @media print rules in styles.css
   do the page setup). Vector output: sharp diagrams and selectable, searchable
   text in every script — things an image-based exporter can never produce. */
async function exportPdf(){
  toast('Choose "Save as PDF" in the print dialog');
  const restoreDiagrams=await lightenDiagramsForExport();
  try{ window.print(); }        // blocks while the dialog is open
  finally{ restoreDiagrams(); }
}

/* ============================================================
   9. Copy menu — Markdown / HTML / Plain text
   ============================================================ */
const copyMenu=document.getElementById("copyMenu");
document.getElementById("copyBtn").onclick=e=>{
  e.stopPropagation();
  exportMenu.classList.remove("open"); // only one menu open at a time
  copyMenu.classList.toggle("open");
};
document.addEventListener("click",()=>copyMenu.classList.remove("open"));
copyMenu.querySelectorAll("[data-copy]").forEach(btn=>{
  btn.onclick=async()=>{
    copyMenu.classList.remove("open");
    let content,label;
    if(btn.dataset.copy==="md"){ content=editor.value; label="Markdown"; }
    else if(btn.dataset.copy==="html"){ content=preview.innerHTML; label="HTML"; }
    else { content=preview.innerText; label="Plain text"; }
    try{ await navigator.clipboard.writeText(content); toast(label+" copied to clipboard"); }
    catch{ toast("Copy failed — clipboard blocked",true); }
  };
});

/* ============================================================
   10. Text direction (LTR / RTL)
   ============================================================ */
const dirBtn=document.getElementById("dirBtn");
function setDir(dir){
  editor.dir=dir;
  preview.dir=dir;
  // swap the placeholder so it reads naturally in each direction (avoids bidi mangling)
  editor.placeholder = dir==="rtl" ? "متن مارک‌داون را اینجا بنویسید…" : "# Write markdown here…";
  dirBtn.textContent = dir==="rtl" ? "⇄ LTR" : "⇄ RTL";
  localStorage.setItem(DIR_KEY,dir);
}
setDir(localStorage.getItem(DIR_KEY) || "ltr");
dirBtn.onclick=()=>setDir(editor.dir==="rtl"?"ltr":"rtl");

/* ============================================================
   11. Theme toggle
   ============================================================ */
document.getElementById("themeBtn").onclick=()=>{
  const cur=document.documentElement.getAttribute("data-theme");
  const next=cur==="dark"?"light":"dark";
  document.documentElement.setAttribute("data-theme",next);
  localStorage.setItem(THEME_KEY,next);
  rethemeMermaid(); // diagram colours are baked into the SVG at render time
  rethemeHljs();
};

/* ============================================================
   11b. Reading mode — just the rendered document, read-only
   ============================================================ */
/* Hides the chrome (header, footer, editor pane) and locks every editing
   path: contenteditable off, formatting bar and custom context menu skipped,
   checkboxes inert, and Ctrl+F handed back to the browser's own find. */
function isReading(){ return document.body.classList.contains("reading"); }
function setReading(on){
  document.body.classList.toggle("reading",on);
  preview.contentEditable = on ? "false" : "true";
  fmtbar.hidden=true;
  hMenu.classList.remove("open");
  findbar.hidden=true;
}
document.getElementById("readBtn").onclick=()=>setReading(true);
document.getElementById("readExit").onclick=()=>setReading(false);
document.addEventListener("keydown",e=>{
  if(e.key==="Escape" && isReading() && !document.querySelector(".modal-backdrop"))
    setReading(false);
});

/* ============================================================
   12. Resizable panes (horizontal on desktop, vertical on mobile)
   ============================================================ */
function setSplit(pct){
  pct=Math.min(85,Math.max(15,pct));
  editPane.style.flexBasis=pct+"%";
  localStorage.setItem(SPLIT_KEY,pct);
}
if(localStorage.getItem(SPLIT_KEY)) setSplit(parseFloat(localStorage.getItem(SPLIT_KEY)));

function startDrag(e){
  e.preventDefault();
  const vertical=window.innerWidth<=720; // stacked layout → drag up/down
  divider.classList.add("dragging");
  document.body.style.cursor=vertical?"row-resize":"col-resize";
  document.body.style.userSelect="none";
  const move=ev=>{
    const p=ev.touches?ev.touches[0]:ev;
    const r=main.getBoundingClientRect();
    const pct=vertical ? (p.clientY-r.top)/r.height*100
                       : (p.clientX-r.left)/r.width*100;
    setSplit(pct);
  };
  const up=()=>{
    divider.classList.remove("dragging");
    document.body.style.cursor="";
    document.body.style.userSelect="";
    window.removeEventListener("mousemove",move);
    window.removeEventListener("mouseup",up);
    window.removeEventListener("touchmove",move);
    window.removeEventListener("touchend",up);
  };
  window.addEventListener("mousemove",move);
  window.addEventListener("mouseup",up);
  window.addEventListener("touchmove",move,{passive:false});
  window.addEventListener("touchend",up);
}
divider.addEventListener("mousedown",startDrag);
divider.addEventListener("touchstart",startDrag,{passive:false});
divider.addEventListener("dblclick",()=>setSplit(50));

/* ============================================================
   13. Synced scrolling
   ============================================================ */
const syncBtn=document.getElementById("syncBtn");
let syncOn=localStorage.getItem(SYNC_KEY)!=="off"; // default on
function updateSyncBtn(){ syncBtn.classList.toggle("active",syncOn); }
updateSyncBtn();
syncBtn.onclick=()=>{
  syncOn=!syncOn;
  localStorage.setItem(SYNC_KEY,syncOn?"on":"off");
  updateSyncBtn();
  toast(syncOn?"Scroll sync on":"Scroll sync off");
};
let scrollLock=null;
function syncScroll(src,dst){
  if(!syncOn) return;
  if(scrollLock&&scrollLock!==src) return;
  scrollLock=src;
  const sMax=src.scrollHeight-src.clientHeight;
  const dMax=dst.scrollHeight-dst.clientHeight;
  dst.scrollTop = sMax>0 ? (src.scrollTop/sMax)*dMax : 0;
  requestAnimationFrame(()=>{ scrollLock=null; });
}
editor.addEventListener("scroll",()=>syncScroll(editor,preview),{passive:true});
preview.addEventListener("scroll",()=>syncScroll(preview,editor),{passive:true});

/* ============================================================
   14. Mobile view switch (Both / Editor / Preview)
   ============================================================ */
const viewBtn=document.getElementById("viewBtn");
const VIEWS=[
  {cls:"",               label:"◫ Both"},
  {cls:"mobile-edit",    label:"✎ Editor"},
  {cls:"mobile-preview", label:"◉ Preview"},
];
let viewIdx=0;
viewBtn.onclick=()=>{
  document.body.classList.remove("mobile-edit","mobile-preview");
  viewIdx=(viewIdx+1)%VIEWS.length;
  if(VIEWS[viewIdx].cls) document.body.classList.add(VIEWS[viewIdx].cls);
  viewBtn.textContent=VIEWS[viewIdx].label;
};

/* ============================================================
   15. Preview formatting toolbar (select or right-click)
   ============================================================ */
const fmtbar=document.getElementById("fmtbar");

// anchor the bar above `rect` (a selection rect, or a zero-width rect at the cursor)
function positionFmtbar(rect){
  hMenu.classList.remove("open"); // don't carry a stale open submenu to a new spot
  fmtbar.hidden=false; // must be visible to measure
  const bw=fmtbar.offsetWidth, bh=fmtbar.offsetHeight;
  let top=rect.top-bh-8;
  if(top<4) top=rect.bottom+8; // flip below if there is no room above
  let left=rect.left+rect.width/2-bw/2;
  left=Math.max(6,Math.min(left,window.innerWidth-bw-6));
  top=Math.max(6,Math.min(top,window.innerHeight-bh-6));
  fmtbar.style.top=top+"px";
  fmtbar.style.left=left+"px";
}

function showFmtbarForSelection(){
  if(isReading()){ fmtbar.hidden=true; return; }
  const sel=window.getSelection();
  if(!sel || sel.isCollapsed || !sel.rangeCount || !preview.contains(sel.anchorNode)){
    fmtbar.hidden=true; return;
  }
  const rect=sel.getRangeAt(0).getBoundingClientRect();
  if(!rect.width && !rect.height){ fmtbar.hidden=true; return; }
  positionFmtbar(rect);
}

// show on selection (mouse or keyboard). Chrome fires mouseup *after* contextmenu
// on a right-click, so without the button guard it would immediately re-hide the
// bar the contextmenu handler below just opened.
preview.addEventListener("mouseup",e=>{
  if(e.button===2) return;
  setTimeout(showFmtbarForSelection,0);
});
preview.addEventListener("keyup",()=>setTimeout(showFmtbarForSelection,0));
// show on right-click (also lets you insert a table with no selection)
preview.addEventListener("contextmenu",e=>{
  if(isReading()) return; // reading mode keeps the browser's own menu
  e.preventDefault();
  positionFmtbar({top:e.clientY,bottom:e.clientY,left:e.clientX,width:0});
});

// keep the selection alive when clicking a toolbar button
fmtbar.addEventListener("mousedown",e=>e.preventDefault());
// hide when clicking outside, scrolling, or resizing
document.addEventListener("mousedown",e=>{
  if(!fmtbar.hidden && !fmtbar.contains(e.target) && !preview.contains(e.target)) fmtbar.hidden=true;
});
window.addEventListener("scroll",()=>{ fmtbar.hidden=true; linkStatus.hidden=true; },{capture:true,passive:true});
window.addEventListener("resize",()=>{ fmtbar.hidden=true; });

function wrapInline(tag){
  const sel=window.getSelection();
  if(!sel.rangeCount || sel.isCollapsed) return;
  const range=sel.getRangeAt(0);
  const el=document.createElement(tag);
  try{ range.surroundContents(el); }
  catch{ el.appendChild(range.extractContents()); range.insertNode(el); }
  // keep the selection INSIDE the new element, so a second press detects & toggles it off
  const r=document.createRange();
  r.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(r);
}

// find an inline <code> ancestor of the selection (ignores code inside a <pre> block)
function inlineCodeAncestor(){
  let node=window.getSelection().anchorNode;
  while(node && node!==preview){
    if(node.nodeType===1 && node.tagName==="CODE" &&
       (!node.parentNode || node.parentNode.tagName!=="PRE")) return node;
    node=node.parentNode;
  }
  return null;
}

// toggle: unwrap if already inline code, otherwise wrap the selection
function toggleInlineCode(){
  const code=inlineCodeAncestor();
  if(code){
    const parent=code.parentNode;
    const moved=[...code.childNodes];
    while(code.firstChild) parent.insertBefore(code.firstChild,code);
    parent.removeChild(code);
    // reselect the unwrapped text so repeated toggling keeps working
    if(moved.length){
      const sel=window.getSelection();
      const r=document.createRange();
      r.setStartBefore(moved[0]);
      r.setEndAfter(moved[moved.length-1]);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }else{
    wrapInline("code");
  }
}

function buildTableHTML(cols,rows){
  let head="<tr>";
  for(let c=0;c<cols;c++) head+=`<th>Header ${c+1}</th>`;
  head+="</tr>";
  let body="";
  for(let r=0;r<rows;r++){
    body+="<tr>";
    for(let c=0;c<cols;c++) body+="<td>Cell</td>";
    body+="</tr>";
  }
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table><p><br></p>`;
}

async function addTable(){
  const sel=window.getSelection();
  // remember the caret — opening the modal moves focus away and clears it
  const saved = (sel.rangeCount && preview.contains(sel.anchorNode)) ? sel.getRangeAt(0).cloneRange() : null;
  const size=await tableSizeModal();
  if(size){
    preview.focus();
    if(saved){ sel.removeAllRanges(); sel.addRange(saved); }
    else { // no caret in preview → append at the end
      const r=document.createRange();
      r.selectNodeContents(preview); r.collapse(false);
      sel.removeAllRanges(); sel.addRange(r);
    }
    document.execCommand("insertHTML",false,buildTableHTML(size.cols,size.rows));
  }
  syncPreviewToMarkdown();
  showFmtbarForSelection();
}

async function addLink(){
  const sel=window.getSelection();
  // remember the selection — opening the modal moves focus away and clears it
  const saved = (sel.rangeCount && preview.contains(sel.anchorNode)) ? sel.getRangeAt(0).cloneRange() : null;
  const url=await promptModal("Link URL:","https://","Add link");
  if(url){
    preview.focus();
    if(saved){ sel.removeAllRanges(); sel.addRange(saved); }
    document.execCommand("createLink",false,url);
  }
  syncPreviewToMarkdown();
  showFmtbarForSelection();
}

// closest element ancestor of the selection (inside the preview) matching `sel`
function selectionAncestor(sel){
  let node=window.getSelection().anchorNode;
  if(!node) return null;
  if(node.nodeType!==1) node=node.parentElement;
  while(node && node!==preview){
    if(node.matches(sel)) return node;
    node=node.parentElement;
  }
  return null;
}

/* formatBlock is not a toggle, and inside a list item Chrome NESTS the result
   (li > h1 > h1 > …) — each click compounds the em-based font size. Markdown
   can't express a heading or quote inside a list item anyway, so refuse there;
   elsewhere, a second click toggles back to a paragraph. */
function toggleBlock(tag){
  if(selectionAncestor("li")){ toast("Headings can't go inside a list item",true); return; }
  document.execCommand("formatBlock",false,selectionAncestor(tag)? "P" : tag.toUpperCase());
}
function toggleQuote(){
  if(selectionAncestor("li")){ toast("Quotes can't go inside a list item",true); return; }
  if(selectionAncestor("blockquote")) document.execCommand("outdent"); // unwraps the quote
  else document.execCommand("formatBlock",false,"BLOCKQUOTE");
}

function applyCmd(cmd){
  preview.focus();
  switch(cmd){
    case "bold":   document.execCommand("bold"); break;
    case "italic": document.execCommand("italic"); break;
    case "strike": document.execCommand("strikeThrough"); break;
    case "code":   toggleInlineCode(); break;
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
                   toggleBlock(cmd); break;
    case "quote":  toggleQuote(); break;
    case "ul":     document.execCommand("insertUnorderedList"); break;
    case "ol":     document.execCommand("insertOrderedList"); break;
    case "task":   document.execCommand("insertHTML",false,
                     '<ul class="task-list"><li class="task-item">'+
                     '<input type="checkbox" aria-label="Task"> Task</li></ul>'); break;
    case "link":   addLink(); return; // async (styled modal) — handles its own sync
    case "table":  addTable(); return; // async (size modal) — handles its own sync
  }
  syncPreviewToMarkdown();
  showFmtbarForSelection();
}
fmtbar.querySelectorAll("button[data-cmd]").forEach(b=>{
  b.onclick=()=>applyCmd(b.dataset.cmd);
});

// Heading submenu (H1–H6), same open/close pattern as the header menus.
const hMenu=document.getElementById("hMenu");
document.getElementById("hBtn").onclick=e=>{
  e.stopPropagation();
  hMenu.classList.toggle("open");
};
// a click anywhere else (including a heading item — it bubbles) closes it
document.addEventListener("click",()=>hMenu.classList.remove("open"));

/* ============================================================
   16. Drag & drop import (.md / .markdown / .txt)
   ============================================================ */
const dropzone=document.getElementById("dropzone");
let dragDepth=0;
function dragHasFiles(e){
  return e.dataTransfer && Array.from(e.dataTransfer.types||[]).includes("Files");
}
window.addEventListener("dragenter",e=>{
  if(!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropzone.classList.add("show");
});
window.addEventListener("dragover",e=>{ if(dragHasFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave",e=>{
  if(!dragHasFiles(e)) return;
  dragDepth--;
  if(dragDepth<=0){ dragDepth=0; dropzone.classList.remove("show"); }
});
window.addEventListener("drop",e=>{
  e.preventDefault();
  dragDepth=0;
  dropzone.classList.remove("show");
  const f=Array.from(e.dataTransfer?.files||[])
    .find(f=>/\.(md|markdown|txt|text)$/i.test(f.name) || (f.type||"").startsWith("text/"));
  if(f) loadFile(f);
  else toast("Drop a .md, .markdown or .txt file",true);
});

/* ============================================================
   17. Find & Replace (Ctrl/Cmd+F) — operates on the editor
   ============================================================ */
const findbar=document.getElementById("findbar");
const findInput=document.getElementById("findInput");
const replaceInput=document.getElementById("replaceInput");
const findCount=document.getElementById("findCount");

function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }

function findMatches(){
  const term=findInput.value;
  if(!term) return [];
  const hay=editor.value.toLowerCase(), needle=term.toLowerCase();
  const out=[]; let i=hay.indexOf(needle);
  while(i!==-1){ out.push(i); i=hay.indexOf(needle,i+needle.length); }
  return out;
}
function refreshFindCount(){
  const m=findMatches();
  findCount.textContent = findInput.value ? (m.length+" found") : "";
}
function scrollEditorTo(pos){
  const line=editor.value.slice(0,pos).split("\n").length-1;
  const lh=parseFloat(getComputedStyle(editor).lineHeight)||20;
  editor.scrollTop=Math.max(0, line*lh - editor.clientHeight/2);
}
function gotoMatch(dir){
  const term=findInput.value; if(!term) return;
  const matches=findMatches();
  refreshFindCount();
  if(!matches.length) return;
  const len=term.length;
  let pos;
  if(dir>0){
    pos=matches.find(i=>i>=editor.selectionEnd);
    if(pos===undefined) pos=matches[0];               // wrap to start
  }else{
    const before=matches.filter(i=>i<editor.selectionStart);
    pos=before.length ? before[before.length-1] : matches[matches.length-1]; // wrap to end
  }
  editor.focus();
  editor.setSelectionRange(pos,pos+len);
  scrollEditorTo(pos);
}
function replaceCurrent(){
  const term=findInput.value; if(!term) return;
  const cur=editor.value.substring(editor.selectionStart,editor.selectionEnd);
  // execCommand → undoable with Ctrl+Z, and fires `input` so update() runs
  if(cur.toLowerCase()===term.toLowerCase()) typeText(replaceInput.value);
  gotoMatch(1);
}
function replaceAllMatches(){
  const term=findInput.value; if(!term) return;
  const n=findMatches().length;
  if(!n) return;
  const re=new RegExp(escapeRegex(term),"gi");
  const rep=replaceInput.value.replace(/\$/g,"$$$$"); // keep "$" literal in the replacement
  const newVal=editor.value.replace(re,rep);
  // select-all + insertText so the whole replace is a single undoable step
  editor.focus();
  editor.select();
  document.execCommand("insertText",false,newVal);
  refreshFindCount();
  toast(n+" replaced");
}
function openFind(){
  findbar.hidden=false;
  findbar.style.top=(header.offsetHeight+8)+"px"; // header wraps on narrow screens
  const s=editor.value.substring(editor.selectionStart,editor.selectionEnd);
  if(s && !s.includes("\n")) findInput.value=s;
  findInput.focus(); findInput.select();
  refreshFindCount();
}
function closeFind(){ findbar.hidden=true; editor.focus(); }

document.addEventListener("keydown",e=>{
  // e.code is the physical key, so this still fires on non-Latin layouts
  // (with a Persian layout e.key would be "ب", never "f")
  if((e.ctrlKey||e.metaKey) && (e.code==="KeyF" || e.key==="f" || e.key==="F")){
    if(isReading()) return; // the browser's native find suits a read-only page
    e.preventDefault();
    openFind();
  }
});
findInput.addEventListener("input",refreshFindCount);
// Escape closes from anywhere in the bar, including the buttons
findbar.addEventListener("keydown",e=>{
  if(e.key==="Escape"){ e.preventDefault(); closeFind(); }
});
findInput.addEventListener("keydown",e=>{
  if(e.key==="Enter"){ e.preventDefault(); gotoMatch(e.shiftKey?-1:1); }
});
replaceInput.addEventListener("keydown",e=>{
  if(e.key==="Enter"){ e.preventDefault(); replaceCurrent(); }
});
document.getElementById("findNext").onclick=()=>gotoMatch(1);
document.getElementById("findPrev").onclick=()=>gotoMatch(-1);
document.getElementById("replaceOne").onclick=replaceCurrent;
document.getElementById("replaceAll").onclick=replaceAllMatches;
document.getElementById("findClose").onclick=closeFind;

})();

