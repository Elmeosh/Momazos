/* ---------------------------------------------------------
   MEME PARTY — demo de juego multijugador de memes
   Estado compartido vía Firebase Realtime Database, así que ahora sí
   sincroniza entre dispositivos distintos (celulares, computadoras
   diferentes), no solo entre pestañas del mismo navegador.
   La configuración e inicialización de Firebase están en index.html
   (deben cargarse ANTES que este archivo).
   --------------------------------------------------------- */

// Silueta genérica gris — se usa como foto de perfil para cualquier jugador
// que no suba su propia imagen (no es una opción elegible, solo el estado
// "sin foto").
const DEFAULT_AVATAR = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">
    <rect width="160" height="160" fill="#e7ddc9"/>
    <circle cx="80" cy="62" r="32" fill="#b9ae95"/>
    <path d="M20 150 Q80 96 140 150 Z" fill="#b9ae95"/>
  </svg>`
);

const ROOM_KEY = 'meme_room_v1';
const TPL_KEY = 'meme_templates_v1';

const DEFAULT_ROOM = {
  users: {},
  hostId: null,
  status: 'lobby', // lobby | caption | reveal | roundend | gameend
  round: 0,
  totalRounds: 5,
  roundSeconds: 60,
  votingSeconds: 30,
  playerTemplates: {},     // { userId: templateId } — cada jugador ve su propia plantilla
  playerRerollsLeft: {},   // { userId: number }
  templateUseCounts: {},   // { userId: { templateId: veces que le salió } } — para bajar la probabilidad de repetir
  roundEndsAt: null,
  submissions: {},     // { userId: { templateId, texts:[...] } }
  revealOrder: [],      // [userId,...]
  revealIndex: 0,
  voteEndsAt: null,
  voteAllInTriggered: false,
  votes: {},            // { authorId: { voterId: { rating: 1|0|-1|null, buddy: bool } } }
  scores: {},           // { userId: number }
  lastRoundBreakdown: null,
  roundEndEndsAt: null, // deadline de los 30s para descargar memes / marcarse "listo"
  roundEndReady: {}     // { userId: true } — quién ya confirmó que puede seguir
};

function builtinTemplates(){
  // Plantillas de ejemplo genéricas (gráficos simples, sin material protegido)
  const t1 = svgTemplate1();
  const t2 = svgTemplate2();
  return [
    {
      id: 'builtin-1',
      name: 'Arriba / Abajo',
      image: t1,
      boxes: [
        {x:8,y:4,w:84,h:16,fontSize:7},
        {x:8,y:80,w:84,h:16,fontSize:7}
      ]
    },
    {
      id: 'builtin-2',
      name: 'Comparación lado a lado',
      image: t2,
      boxes: [
        {x:4,y:4,w:44,h:14,fontSize:6},
        {x:52,y:4,w:44,h:14,fontSize:6},
        {x:4,y:78,w:44,h:16,fontSize:6},
        {x:52,y:78,w:44,h:16,fontSize:6}
      ]
    }
  ];
}

function svgTemplate1(){
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
    <rect width="600" height="600" fill="#dfe6ea"/>
    <circle cx="300" cy="320" r="150" fill="#f4c98f" stroke="#c98f4f" stroke-width="6"/>
    <circle cx="250" cy="290" r="18" fill="#3a2e2e"/>
    <circle cx="350" cy="290" r="18" fill="#3a2e2e"/>
    <path d="M240 380 Q300 430 360 380" stroke="#3a2e2e" stroke-width="10" fill="none" stroke-linecap="round"/>
  </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
function svgTemplate2(){
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">
    <rect width="600" height="400" fill="#efe4d6"/>
    <rect x="0" y="0" width="300" height="400" fill="#f6b8a0"/>
    <rect x="300" y="0" width="300" height="400" fill="#a0c9f6"/>
    <circle cx="150" cy="230" r="70" fill="#fff" stroke="#c97a5a" stroke-width="6"/>
    <circle cx="450" cy="230" r="70" fill="#fff" stroke="#5a86c9" stroke-width="6"/>
    <text x="150" y="240" font-size="50" text-anchor="middle" fill="#c97a5a">A</text>
    <text x="450" y="240" font-size="50" text-anchor="middle" fill="#5a86c9">B</text>
  </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

// ---------- Estado local de sesión (no persiste al cerrar la pestaña) ----------
let myId = 'u_' + Math.random().toString(36).slice(2, 10);
let myName = '';
let myAvatar = null; // null = el jugador no subió foto propia; se usará DEFAULT_AVATAR
let joined = false;

let room = null;
let templates = [];

let newTplFiles = [];       // archivos seleccionados en el <input multiple>
let newTplFileIndex = 0;    // cuál de esos archivos se está configurando ahora
let newTplDrafts = [];      // borrador por archivo: {imageData, name, boxes} | null (aún no procesado)
let newTplBoxes = [];       // recuadros del archivo actualmente en pantalla (referencia al borrador)
let drawingBox = null;

// ---------- Helpers de almacenamiento (Firebase Realtime Database) ----------
// Estas funciones mantienen la MISMA firma que antes (síncronas, sin
// promesas) para no tener que tocar el resto del juego: loadRoom()/
// loadTemplates() devuelven al instante la última copia recibida de
// Firebase (guardada en las variables `room`/`templates`), y saveRoom()/
// saveTemplates() actualizan esa copia local de inmediato (para que el
// resto del código que sigue ejecutándose en la misma función ya la vea
// actualizada) y además la mandan a Firebase en segundo plano.
// La sincronización real en tiempo real entre dispositivos pasa por los
// listeners `.on('value', ...)` que están al final del archivo.
const dbRoomRef = firebase.database().ref(ROOM_KEY);
const dbTplRef = firebase.database().ref(TPL_KEY);

// OJO con esto: Firebase Realtime Database NO guarda objetos {} ni arrays
// [] vacíos — al escribirlos, simplemente borra esa clave. Eso significa
// que campos como `users`, `votes`, `playerTemplates`, etc. pueden llegar
// como `undefined` después de un viaje de ida y vuelta por Firebase (por
// ejemplo, apenas se reinicia la sala y queda con 0 usuarios). Como el
// resto del juego asume que esos campos SIEMPRE son al menos {} o [],
// normalizamos cualquier dato que venga de Firebase antes de usarlo.
function normalizeRoom(val){
  const base = JSON.parse(JSON.stringify(DEFAULT_ROOM));
  if(!val) return base;
  const merged = Object.assign(base, val);
  merged.users = val.users || {};
  merged.submissions = val.submissions || {};
  merged.votes = val.votes || {};
  merged.scores = val.scores || {};
  merged.revealOrder = val.revealOrder || [];
  merged.playerTemplates = val.playerTemplates || {};
  merged.playerRerollsLeft = val.playerRerollsLeft || {};
  merged.templateUseCounts = val.templateUseCounts || {};
  merged.roundEndReady = val.roundEndReady || {};
  return merged;
}

function loadRoom(){
  return normalizeRoom(room);
}
function saveRoom(r){
  room = normalizeRoom(r);
  dbRoomRef.set(room).catch(e=>console.error('No se pudo guardar la sala en Firebase', e));
}
function loadTemplates(){
  return (templates && templates.length) ? templates : builtinTemplates();
}
function saveTemplates(arr){
  templates = arr;
  dbTplRef.set(arr).catch(e=>console.error('No se pudieron guardar las plantillas en Firebase', e));
}

function tplById(id){ return templates.find(t => t.id === id); }
function isHost(){ return room && room.hostId === myId; }

// Muestra/oculta los botones de configuración y moderación según si el
// jugador actual es el anfitrión de la sala. Se llama en cada render(), así
// que si el anfitrión cambia (por ejemplo, se fue y se reasignó a otro
// jugador) los botones aparecen/desaparecen automáticamente para todos.
function updateHostControls(){
  const host = isHost();
  document.getElementById('btnSettings').classList.toggle('hidden', !host);
  document.getElementById('btnResetRoom').classList.toggle('hidden', !host);
  document.getElementById('btnStartGame').classList.toggle('hidden', !host);
  const showEndGame = host && room.status !== 'lobby';
  document.getElementById('btnEndGame').classList.toggle('hidden', !showEndGame);
}

// Si el anfitrión registrado ya no está entre los usuarios conectados
// (por ejemplo, cerró la pestaña sin que se alcanzara a limpiar), se
// reasigna a otro jugador presente. Devuelve true si hubo que corregirlo.
function ensureValidHost(r){
  const ids = Object.keys(r.users);
  if(ids.length === 0){
    if(r.hostId !== null){ r.hostId = null; return true; }
    return false;
  }
  if(!r.hostId || !r.users[r.hostId]){
    r.hostId = ids[0];
    return true;
  }
  return false;
}

// ---------- Foto de perfil (login) ----------
// Ya no hay animalitos/emotes predefinidos. Subir foto es opcional: si el
// jugador no sube ninguna, se usa una silueta genérica (DEFAULT_AVATAR).
function renderAvatarPreview(){
  const el = document.getElementById('avatarPreview');
  el.innerHTML = `<img src="${myAvatar || DEFAULT_AVATAR}">`;
}
document.getElementById('avatarUpload').onchange = (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  resizeImageFile(file, 160, 160).then(dataUrl=>{
    myAvatar = dataUrl;
    renderAvatarPreview();
  });
};

function resizeImageFile(file, maxW, maxH){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>{
      const img = new Image();
      img.onload = ()=>{
        let w = img.width, h = img.height;
        const ratio = Math.min(maxW/w, maxH/h, 1);
        w = Math.round(w*ratio); h = Math.round(h*ratio);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Los GIF no se pasan por canvas (eso "aplanaría" la animación en un solo
// cuadro estático), así que se guardan tal cual como dataURL.
function fileToDataUrl(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function processTemplateImageFile(file){
  const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name);
  return isGif ? fileToDataUrl(file) : resizeImageFile(file, 800, 800);
}

renderAvatarPreview();

// ---------- Login / unirse a la sala ----------
document.getElementById('btnJoin').onclick = ()=>{
  if(!firebaseSynced.room || !firebaseSynced.templates) return; // aún conectando con Firebase
  const name = document.getElementById('loginName').value.trim();
  const errEl = document.getElementById('loginError');
  if(!name){
    errEl.textContent = 'Escribe un nombre de usuario.';
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');
  room = loadRoom();
  templates = loadTemplates();
  room.users[myId] = { name, avatar: myAvatar || DEFAULT_AVATAR };
  if(!room.hostId) room.hostId = myId;
  ensureValidHost(room);
  if(room.scores[myId] === undefined) room.scores[myId] = 0;
  saveRoom(room);
  myName = name;
  joined = true;
  // Limpieza automática real: si esta pestaña pierde la conexión con
  // Firebase (se cierra, se queda sin señal, se cierra el navegador, etc.),
  // el propio servidor de Firebase borra a este jugador de la sala — ya no
  // depende de que el navegador alcance a avisar (a diferencia del evento
  // "beforeunload" de antes, que no siempre se disparaba a tiempo). Esto
  // evita que se acumulen más jugadores fantasma y que el rol de anfitrión
  // se quede atascado en alguien que ya no está.
  dbRoomRef.child('users').child(myId).onDisconnect().remove();
  document.getElementById('headerUser').classList.remove('hidden');
  document.getElementById('headerName').textContent = myName;
  renderHeaderAvatar();
  render();
};

function renderHeaderAvatar(){
  const el = document.getElementById('headerAvatar');
  el.innerHTML = `<img src="${myAvatar || DEFAULT_AVATAR}">`;
}

// ---------- Lobby ----------
document.getElementById('btnSettings').onclick = ()=>{
  if(!isHost()) return; // solo el anfitrión puede entrar a Configuración
  showScreen('settings'); populateSettingsForm();
};
document.getElementById('btnBackToLobby').onclick = ()=>{ showScreen('lobby'); render(); };

document.getElementById('btnResetRoom').onclick = ()=>{
  if(!isHost()) return; // botón de moderación: solo el anfitrión
  if(!confirm('¿Reiniciar toda la sala? Esto borra usuarios y puntajes.')) return;
  const fresh = JSON.parse(JSON.stringify(DEFAULT_ROOM));
  saveRoom(fresh);
  leaveSession();
};

// Salir de la sala: te quita de la lista de usuarios (y de puntajes) y te
// devuelve al login, sin afectar a los demás jugadores conectados.
document.getElementById('btnLeaveRoom').onclick = ()=>{
  removeMeFromRoom();
  leaveSession();
};

// El anfitrión puede terminar la partida en curso y volver al lobby en
// cualquier momento, sin esperar a que se completen todas las rondas.
// Se conservan los usuarios y los puntajes acumulados.
document.getElementById('btnEndGame').onclick = ()=>{
  if(!isHost()) return; // botón de moderación: solo el anfitrión
  if(!confirm('¿Terminar la partida actual y volver al lobby?')) return;
  room = loadRoom();
  room.status = 'lobby';
  room.round = 0;
  room.playerTemplates = {};
  room.playerRerollsLeft = {};
  room.roundEndsAt = null;
  room.submissions = {};
  room.revealOrder = [];
  room.revealIndex = 0;
  room.votes = {};
  room.voteEndsAt = null;
  room.voteAllInTriggered = false;
  room.lastRoundBreakdown = null;
  room.roundEndEndsAt = null;
  room.roundEndReady = {};
  saveRoom(room);
  captionFieldsBuiltForKey = null;
};

function removeMeFromRoom(){
  try{
    const r = loadRoom();
    if(r.users[myId]){
      delete r.users[myId];
      delete r.scores[myId];
      delete r.submissions[myId];
      delete r.votes[myId];
      if(r.hostId === myId){
        const remaining = Object.keys(r.users);
        r.hostId = remaining.length ? remaining[0] : null;
      }
      // Si ya no queda nadie jugando, no tiene sentido dejar la sala a medio
      // camino de una ronda: la reiniciamos al lobby (conservando las
      // opciones de configuración) para que el próximo que entre arranque limpio.
      if(Object.keys(r.users).length === 0){
        const fresh = JSON.parse(JSON.stringify(DEFAULT_ROOM));
        fresh.totalRounds = r.totalRounds;
        fresh.roundSeconds = r.roundSeconds;
        saveRoom(fresh);
      }else{
        saveRoom(r);
      }
    }
  }catch(e){ console.error(e); }
}

function leaveSession(){
  joined = false;
  captionFieldsBuiltForKey = null;
  document.getElementById('loginName').value = '';
  document.getElementById('headerUser').classList.add('hidden');
  showScreen('login');
}

// Intento de limpieza si cierran la pestaña o el navegador (no es 100% garantizado
// en todos los navegadores, pero ayuda a que no queden usuarios "fantasma").
window.addEventListener('beforeunload', ()=>{
  if(joined) removeMeFromRoom();
});

document.getElementById('btnStartGame').onclick = ()=>{
  if(!isHost()) return; // solo el anfitrión puede iniciar la partida
  room = loadRoom();
  if(templates.length === 0){
    alert('Agrega al menos una plantilla en Configuración antes de iniciar.');
    return;
  }
  if(Object.keys(room.users).length < 1) return;
  startRound(room, true);
};

// Elige una plantilla al azar para UN jugador puntual. Todas las plantillas
// pueden salir siempre (no se descarta ninguna), pero las que ya le salieron
// antes a ESE jugador pesan menos en el sorteo, así es menos probable (no
// imposible) que se repitan para él.
function pickTemplateForPlayer(usedCounts){
  const weighted = templates.map(t => ({
    t,
    weight: 1 / (1 + (usedCounts[t.id] || 0))
  }));
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  let roll = Math.random() * total;
  for(const w of weighted){
    if(roll < w.weight) return w.t;
    roll -= w.weight;
  }
  return weighted[weighted.length - 1].t;
}

function startRound(r, isFirst){
  r.round = isFirst ? 1 : r.round + 1;
  r.status = 'caption';
  r.roundEndsAt = Date.now() + r.roundSeconds*1000;
  // Cada jugador recibe su propia plantilla, sorteada de forma independiente
  // de la de los demás (antes era una sola para toda la sala).
  r.playerTemplates = {};
  r.playerRerollsLeft = {};
  Object.keys(r.users).forEach(uid=>{
    const usedCounts = r.templateUseCounts[uid] || {};
    const chosen = pickTemplateForPlayer(usedCounts);
    r.playerTemplates[uid] = chosen.id;
    r.playerRerollsLeft[uid] = 5;
    r.templateUseCounts[uid] = { ...usedCounts, [chosen.id]: (usedCounts[chosen.id] || 0) + 1 };
  });
  r.submissions = {};
  r.revealOrder = [];
  r.revealIndex = 0;
  r.votes = {};
  r.voteEndsAt = null;
  r.voteAllInTriggered = false;
  r.lastRoundBreakdown = null;
  r.roundEndEndsAt = null;
  r.roundEndReady = {};
  saveRoom(r);
}

// ---------- Settings / editor de plantillas ----------
function populateSettingsForm(){
  document.getElementById('cfgRounds').value = room.totalRounds;
  document.getElementById('cfgSeconds').value = room.roundSeconds;
  document.getElementById('cfgVoteSeconds').value = room.votingSeconds !== undefined ? room.votingSeconds : 30;
  renderTemplateThumbs();
}
document.getElementById('btnSaveSettings').onclick = ()=>{
  room = loadRoom();
  room.totalRounds = Math.max(1, parseInt(document.getElementById('cfgRounds').value)||5);
  room.roundSeconds = Math.max(15, parseInt(document.getElementById('cfgSeconds').value)||60);
  room.votingSeconds = Math.max(5, parseInt(document.getElementById('cfgVoteSeconds').value)||30);
  saveRoom(room);
  alert('Opciones guardadas.');
};

function renderTemplateThumbs(){
  document.getElementById('tplCount').textContent = templates.length;
  const box = document.getElementById('templateThumbs');
  box.innerHTML = '';
  templates.forEach(t=>{
    const div = document.createElement('div');
    div.className = 'template-thumb';
    div.innerHTML = `<img src="${t.image}"><div class="tpl-info"><div style="font-weight:600;">${escapeHtml(t.name)}</div><div class="muted" style="font-size:12px;">${t.boxes.length} recuadro(s)</div></div><button class="small danger" data-tplid="${t.id}">🗑️ Eliminar</button>`;
    box.appendChild(div);
  });
  box.querySelectorAll('button[data-tplid]').forEach(btn=>{
    btn.onclick = ()=>{
      const t = templates.find(x=>x.id === btn.dataset.tplid);
      if(!confirm(`¿Eliminar la plantilla "${t ? t.name : ''}"?`)) return;
      templates = loadTemplates().filter(x => x.id !== btn.dataset.tplid);
      saveTemplates(templates);
      renderTemplateThumbs();
      render();
    };
  });
}

// ---------- Selección múltiple de imágenes para nuevas plantillas ----------
// Al elegir varios archivos, se configuran de a uno: se dibuja el/los
// recuadro(s) sobre la imagen actual, se guarda, y automáticamente se
// pasa a la siguiente imagen de la selección.
// ---------- Selección múltiple de imágenes para nuevas plantillas ----------
// Al elegir varios archivos, se configuran de a uno. Nada se guarda en las
// plantillas reales hasta que el usuario pulsa "Guardar plantilla(s)": mientras
// tanto, el nombre y los recuadros de cada imagen quedan en un borrador local
// (newTplDrafts) para poder ir y volver entre imágenes sin perder el trabajo.
document.getElementById('newTplImage').onchange = async (e)=>{
  const files = Array.from(e.target.files || []);
  if(!files.length) return;
  newTplFiles = files;
  newTplDrafts = new Array(files.length).fill(null);
  newTplFileIndex = 0;
  await loadCurrentNewTplFile();
};

// Guarda en el borrador el nombre y los recuadros que se estén viendo
// actualmente, antes de cambiar de imagen o de cerrar el editor.
function commitCurrentDraft(){
  const draft = newTplDrafts[newTplFileIndex];
  if(!draft) return;
  draft.name = document.getElementById('newTplName').value.trim() || draft.name;
  draft.boxes = newTplBoxes;
}

async function loadCurrentNewTplFile(){
  const file = newTplFiles[newTplFileIndex];
  if(!file) return;
  let draft = newTplDrafts[newTplFileIndex];
  if(!draft){
    const imageData = await processTemplateImageFile(file);
    const suggestedName = file.name.replace(/\.[^/.]+$/, '');
    draft = { imageData, name: suggestedName, boxes: [] };
    newTplDrafts[newTplFileIndex] = draft;
  }
  newTplBoxes = draft.boxes;
  document.getElementById('editorImg').src = draft.imageData;
  document.getElementById('newTplName').value = draft.name;
  document.getElementById('editorArea').classList.remove('hidden');
  updateTplQueueLabel();
  renderEditorBoxes();
}

function updateTplQueueLabel(){
  const label = document.getElementById('tplQueueLabel');
  const hint = document.getElementById('tplSaveHint');
  const total = newTplFiles.length;
  if(total > 1){
    label.textContent = `Configurando imagen ${newTplFileIndex+1} de ${total}`;
    label.classList.remove('hidden');
  }else{
    label.classList.add('hidden');
  }
  document.getElementById('btnTplPrev').disabled = newTplFileIndex <= 0;
  document.getElementById('btnTplNext').disabled = newTplFileIndex >= total - 1;
  const configured = newTplDrafts.filter(d => d && d.boxes.length > 0).length;
  hint.textContent = total > 1
    ? `Se guardarán las plantillas que ya tengan al menos un recuadro (${configured} de ${total} lista(s) por ahora).`
    : 'Dibuja al menos un recuadro de texto antes de guardar.';
}

document.getElementById('btnTplPrev').onclick = async ()=>{
  commitCurrentDraft();
  if(newTplFileIndex <= 0) return;
  newTplFileIndex -= 1;
  await loadCurrentNewTplFile();
};

document.getElementById('btnTplNext').onclick = async ()=>{
  commitCurrentDraft();
  if(newTplFileIndex >= newTplFiles.length - 1) return;
  newTplFileIndex += 1;
  await loadCurrentNewTplFile();
};

function resetTplUploadState(){
  newTplFiles = []; newTplFileIndex = 0; newTplDrafts = []; newTplBoxes = [];
  document.getElementById('newTplName').value = '';
  document.getElementById('newTplImage').value = '';
  document.getElementById('editorArea').classList.add('hidden');
  document.getElementById('tplQueueLabel').classList.add('hidden');
}

// Guarda como plantillas reales todos los borradores que ya tengan al menos
// un recuadro dibujado (los que se hayan dejado sin recuadros se descartan
// silenciosamente, ya que nunca se llegaron a configurar) y cierra el editor.
document.getElementById('btnTplSaveAll').onclick = ()=>{
  commitCurrentDraft();
  const ready = newTplDrafts.filter(d => d && d.boxes.length > 0);
  if(ready.length === 0){
    alert('Dibuja al menos un recuadro de texto sobre la imagen antes de guardar.');
    return;
  }
  templates = loadTemplates();
  ready.forEach(d=>{
    templates.push({
      id: 'tpl_' + Math.random().toString(36).slice(2,9),
      name: d.name || 'Sin nombre',
      image: d.imageData,
      boxes: d.boxes
    });
  });
  saveTemplates(templates);
  renderTemplateThumbs();
  const skipped = newTplDrafts.length - ready.length;
  resetTplUploadState();
  alert(skipped > 0
    ? `${ready.length} plantilla(s) guardada(s). ${skipped} imagen(es) sin recuadros no se guardaron.`
    : `${ready.length} plantilla(s) guardada(s).`);
};

// Descarta toda la selección actual (ninguna imagen configurada en esta
// sesión de subida se guarda) y cierra el editor.
document.getElementById('btnTplCancel').onclick = ()=>{
  if(!confirm('¿Cancelar la subida de plantillas? Se perderá lo configurado en esta selección de imágenes.')) return;
  resetTplUploadState();
};

const editorCanvas = document.getElementById('editorCanvas');
editorCanvas.addEventListener('mousedown', (e)=>{
  const rect = editorCanvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 100;
  const y = ((e.clientY - rect.top) / rect.height) * 100;
  drawingBox = { x, y, w:0, h:0 };
});
editorCanvas.addEventListener('mousemove', (e)=>{
  if(!drawingBox) return;
  const rect = editorCanvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 100;
  const y = ((e.clientY - rect.top) / rect.height) * 100;
  drawingBox.w = x - drawingBox.x;
  drawingBox.h = y - drawingBox.y;
  renderEditorBoxes(drawingBox);
});
window.addEventListener('mouseup', ()=>{
  if(!drawingBox) return;
  let {x,y,w,h} = drawingBox;
  if(w < 0){ x = x + w; w = Math.abs(w); }
  if(h < 0){ y = y + h; h = Math.abs(h); }
  if(w > 2 && h > 2){
    newTplBoxes.push({x, y, w, h, fontSize: 6});
  }
  drawingBox = null;
  renderEditorBoxes();
});

function renderEditorBoxes(temp){
  const old = editorCanvas.querySelectorAll('.editor-box');
  old.forEach(n=>n.remove());
  const all = temp ? [...newTplBoxes, temp] : newTplBoxes;
  all.forEach(b=>{
    const div = document.createElement('div');
    div.className = 'editor-box';
    div.style.left = b.x+'%'; div.style.top = b.y+'%';
    div.style.width = Math.abs(b.w)+'%'; div.style.height = Math.abs(b.h)+'%';
    editorCanvas.appendChild(div);
  });
  document.getElementById('boxCountLabel').textContent = newTplBoxes.length + ' recuadro(s)';
  updateTplQueueLabel();
}

document.getElementById('btnUndoBox').onclick = ()=>{
  newTplBoxes.pop();
  renderEditorBoxes();
};

// ---------- Reroll de plantilla dentro de la ronda (máx. 5 por ronda) ----------
document.getElementById('btnRerollTemplate').onclick = ()=>{
  room = loadRoom();
  if(room.status !== 'caption') return;
  if(room.submissions[myId]) return; // ya enviaste tu meme, no se puede recambiar
  const rerollsLeft = room.playerRerollsLeft[myId] !== undefined ? room.playerRerollsLeft[myId] : 5;
  if(rerollsLeft <= 0) return;
  const currentId = room.playerTemplates[myId];
  const others = templates.filter(t => t.id !== currentId);
  if(others.length === 0) return;
  // El reroll siempre te da una plantilla DISTINTA a la actual (para que se
  // note el cambio), elegida al azar entre el resto — esto no afecta a los
  // demás jugadores ni a los memes que ya hayan enviado.
  const next = others[Math.floor(Math.random()*others.length)];
  const usedCounts = room.templateUseCounts[myId] || {};
  room.playerTemplates[myId] = next.id;
  room.playerRerollsLeft[myId] = rerollsLeft - 1;
  room.templateUseCounts[myId] = { ...usedCounts, [next.id]: (usedCounts[next.id] || 0) + 1 };
  saveRoom(room);
};

// ---------- Caption screen ----------
// outlineOnly=true dibuja solo el contorno punteado de cada recuadro (se usa
// en el editor de plantillas). En la pantalla de escritura y en la revelación
// se muestra el texto real; si un recuadro puntual todavía está vacío, ese
// recuadro en particular se ve punteado para indicar dónde va el texto.
function renderCaptionStage(container, tpl, texts, outlineOnly){
  container.innerHTML = `<img src="${tpl.image}">`;
  const img = container.querySelector('img');
  const build = ()=> buildStageBoxes(container, tpl, texts, outlineOnly);
  // Si la imagen (o GIF) todavía no cargó, el contenedor puede no tener aún
  // su alto real, así que esperamos a que cargue para calcular bien el ajuste
  // de la fuente. Si ya está cargada/cacheada, se dibuja de inmediato.
  if(img.complete) build(); else img.onload = build;
}

function buildStageBoxes(container, tpl, texts, outlineOnly){
  container.querySelectorAll('.tbox').forEach(el => el.remove());
  const stageWidth = container.clientWidth || 400;
  tpl.boxes.forEach((b, i)=>{
    const div = document.createElement('div');
    const txt = (texts && texts[i]) ? texts[i] : '';
    const showAsEmpty = outlineOnly || !txt;
    div.className = 'tbox' + (showAsEmpty ? ' outline-only' : '');
    div.style.left = b.x+'%'; div.style.top = b.y+'%';
    div.style.width = b.w+'%'; div.style.height = b.h+'%';
    div.dataset.idx = i;
    // Tamaño de fuente "ideal" según el ancho real del meme en pantalla.
    // A partir de ahí, fitTextToBox lo reduce si hace falta para que el
    // texto siempre entre en su recuadro (ver más abajo).
    const baseFontPx = Math.max(8, stageWidth * (b.fontSize || 6) / 100);
    div.dataset.baseFont = baseFontPx.toFixed(1);
    if(!outlineOnly){
      div.textContent = txt;
    }
    container.appendChild(div);
    if(!outlineOnly && txt){
      fitTextToBox(div, baseFontPx);
    }else{
      div.style.fontSize = baseFontPx + 'px';
    }
  });
}

// Reduce el tamaño de letra de un recuadro, empezando desde su tamaño ideal,
// hasta que el texto entra completo dentro de sus propias dimensiones (ancho
// y alto), para que nunca se corte ni se salga del recuadro. Nunca baja de
// 8px para que siga siendo legible.
function fitTextToBox(div, baseFontPx){
  const minFontPx = 8;
  let fs = baseFontPx;
  div.style.fontSize = fs + 'px';
  let guard = 0;
  while(fs > minFontPx && (div.scrollHeight > div.clientHeight + 1 || div.scrollWidth > div.clientWidth + 1) && guard < 60){
    fs -= 1;
    div.style.fontSize = fs + 'px';
    guard++;
  }
}

// Actualiza un solo recuadro del meme en tiempo real mientras el jugador
// escribe, sin reconstruir todo el escenario (así no se pierde el foco/cursor
// del textarea), reajustando la fuente en cada tecla.
function updateStageBoxText(idx, value){
  const stage = document.getElementById('captionStage');
  const div = stage.querySelector(`.tbox[data-idx="${idx}"]`);
  if(!div) return;
  div.textContent = value;
  const hasText = !!value.trim();
  div.classList.toggle('outline-only', !hasText);
  if(hasText){
    const base = parseFloat(div.dataset.baseFont) || 20;
    fitTextToBox(div, base);
  }
}

// Recuerda para qué ronda/plantilla ya se construyeron los campos de texto,
// para NO reconstruirlos en cada sincronización (eso era lo que borraba lo escrito).
let captionFieldsBuiltForKey = null;

function renderCaptionScreen(){
  const tpl = tplById(room.playerTemplates[myId]);
  if(!tpl) return;
  document.getElementById('captionRoundLabel').textContent = `Ronda ${room.round} de ${room.totalRounds} — ${tpl.name}`;

  const fieldsBox = document.getElementById('captionFields');
  const already = room.submissions[myId];
  const key = room.round + '_' + tpl.id;

  // Solo reconstruimos los <textarea> si cambió la ronda/plantilla.
  // En cada sincronización posterior dejamos los campos tal cual están,
  // así no se pierde lo que el jugador está escribiendo.
  if(captionFieldsBuiltForKey !== key){
    fieldsBox.innerHTML = '';
    tpl.boxes.forEach((b,i)=>{
      const div = document.createElement('div');
      div.className = 'field';
      div.innerHTML = `<label>Texto ${i+1}</label><textarea data-idx="${i}"></textarea>`;
      fieldsBox.appendChild(div);
    });
    // Vista previa en tiempo real: cada vez que se escribe, el recuadro
    // correspondiente del meme se actualiza al instante.
    fieldsBox.querySelectorAll('textarea').forEach(area=>{
      area.addEventListener('input', ()=> updateStageBoxText(area.dataset.idx, area.value));
    });
    captionFieldsBuiltForKey = key;
  }

  const areas = fieldsBox.querySelectorAll('textarea');
  if(already){
    already.texts.forEach((t,i)=>{ if(areas[i] && areas[i].value !== t) areas[i].value = t; });
    areas.forEach(a=> a.disabled = true);
    document.getElementById('captionDoneMsg').classList.remove('hidden');
    document.getElementById('btnSubmitMeme').disabled = true;
  }else{
    areas.forEach(a=> a.disabled = false);
    document.getElementById('captionDoneMsg').classList.add('hidden');
    document.getElementById('btnSubmitMeme').disabled = false;
  }

  // El escenario refleja siempre el texto actual de los campos (ya sea lo
  // que se está escribiendo o lo ya enviado).
  const currentTexts = Array.from(areas).map(a=>a.value);
  const stage = document.getElementById('captionStage');
  renderCaptionStage(stage, tpl, currentTexts, false);

  const submittedCount = Object.keys(room.submissions).length;
  const totalUsers = Object.keys(room.users).length;
  document.getElementById('captionSubmittedInfo').textContent = `${submittedCount} de ${totalUsers} jugadores enviaron su meme.`;

  const rerollsLeft = room.playerRerollsLeft[myId] !== undefined ? room.playerRerollsLeft[myId] : 5;
  document.getElementById('rerollInfo').textContent = `Cambios de plantilla restantes: ${rerollsLeft}`;
  document.getElementById('btnRerollTemplate').disabled = !!already || rerollsLeft <= 0 || templates.length <= 1;
}

document.getElementById('btnSubmitMeme').onclick = ()=>{
  const tpl = tplById(room.playerTemplates[myId]);
  const areas = document.querySelectorAll('#captionFields textarea');
  const texts = Array.from(areas).map(a=>a.value.trim());
  room = loadRoom();
  room.submissions[myId] = { templateId: tpl.id, texts };
  saveRoom(room);
};

function checkAutoAdvanceCaption(){
  if(!room || room.status !== 'caption') return;
  // Solo el anfitrión dispara el avance automático. Antes cualquier jugador
  // conectado podía hacerlo, pero eso significaba que con 2+ jugadores
  // conectados, AMBOS clientes detectaban la condición casi al mismo tiempo
  // y ambos escribían su propia versión del estado a Firebase por separado
  // (cada quien con su propio sorteo de plantillas, su propio revealOrder,
  // etc.). Como Firebase aquí sobrescribe el documento completo en cada
  // guardado (no hace merge), el que "ganaba la carrera" pisoteaba al otro
  // — eso era la causa de plantillas repetidas/en blanco, votos que
  // desaparecían y temporizadores que se reiniciaban antes de tiempo.
  // Si el anfitrión se desconecta, `ensureValidHost()` reasigna el rol a
  // otro jugador conectado automáticamente, así que esto no deja la sala
  // trabada.
  if(!isHost()) return;
  const totalUsers = Object.keys(room.users).length;
  const submittedCount = Object.keys(room.submissions).length;
  const timeUp = room.roundEndsAt && Date.now() >= room.roundEndsAt;
  const allSubmitted = totalUsers > 0 && submittedCount >= totalUsers;
  if(!allSubmitted && !timeUp) return;

  room = loadRoom();
  if(room.status !== 'caption') return; // ya avanzó (otra pestaña llegó primero)
  const order = Object.keys(room.submissions);
  if(order.length === 0){
    room.status = 'roundend';
    room.revealOrder = [];
    room.revealIndex = 0;
    saveRoom(room);
    return;
  }
  room.status = 'reveal';
  room.revealOrder = order;
  room.revealIndex = 0;
  room.votes = {};
  room.voteEndsAt = Date.now() + (room.votingSeconds||30)*1000;
  room.voteAllInTriggered = false;
  saveRoom(room);
}

// ---------- Reveal / voting ----------
function currentRevealUserId(){
  return room.revealOrder[room.revealIndex];
}

// Estructura de cada voto: { rating: 1|0|-1|null, buddy: true|false }
// rating = reacción (Momazo/meh/ZZZ). buddy = si ese jugador apoyó el meme
// con "Meme Buddy" (independiente de su reacción).
function getMyVote(authorId){
  const votesForThis = room.votes[authorId] || {};
  return votesForThis[myId] || { rating: null, buddy: false };
}

function renderRevealScreen(){
  const authorId = currentRevealUserId();
  if(!authorId) return;
  const sub = room.submissions[authorId];
  const tpl = tplById(sub.templateId);
  const author = room.users[authorId] || {name:'???'};
  document.getElementById('revealProgress').textContent = `Meme ${room.revealIndex+1} de ${room.revealOrder.length} — por ${author.name}`;
  const stage = document.getElementById('revealStage');
  renderCaptionStage(stage, tpl, sub.texts, false);

  const isAuthor = authorId === myId;
  const myVote = getMyVote(authorId);
  const timeUp = room.voteEndsAt && Date.now() >= room.voteEndsAt;
  const locked = isAuthor || timeUp;

  document.getElementById('voteRow').style.display = isAuthor ? 'none' : 'flex';
  document.getElementById('btnMemeBuddy').classList.toggle('hidden', isAuthor);

  const btnUp = document.getElementById('btnVoteUp');
  const btnNeutral = document.getElementById('btnVoteNeutral');
  const btnDown = document.getElementById('btnVoteDown');
  const btnBuddy = document.getElementById('btnMemeBuddy');

  btnUp.classList.toggle('active', myVote.rating === 1);
  btnNeutral.classList.toggle('active', myVote.rating === 0);
  btnDown.classList.toggle('active', myVote.rating === -1);
  btnBuddy.classList.toggle('active', !!myVote.buddy);

  btnUp.disabled = locked;
  btnNeutral.disabled = locked;
  btnDown.disabled = locked;
  btnBuddy.disabled = locked;

  document.getElementById('voteHint').textContent = isAuthor
    ? 'No puedes votar tu propio meme.'
    : timeUp
      ? 'Se acabó el tiempo para votar este meme.'
      : (myVote.rating === null ? 'Elige tu reacción — puedes cambiarla hasta que se acabe el tiempo.' : 'Puedes cambiar tu voto mientras no se acabe el tiempo.');

  document.getElementById('btnNextReveal').classList.remove('hidden');
}

function castVote(value){
  const authorId = currentRevealUserId();
  if(!authorId || authorId === myId) return;
  if(room.voteEndsAt && Date.now() >= room.voteEndsAt) return;
  room = loadRoom();
  if(!room.votes[authorId]) room.votes[authorId] = {};
  const prev = room.votes[authorId][myId] || { rating: null, buddy: false };
  room.votes[authorId][myId] = { rating: value, buddy: prev.buddy };
  saveRoom(room);
}
function toggleBuddy(){
  const authorId = currentRevealUserId();
  if(!authorId || authorId === myId) return;
  if(room.voteEndsAt && Date.now() >= room.voteEndsAt) return;
  room = loadRoom();
  if(!room.votes[authorId]) room.votes[authorId] = {};
  const prev = room.votes[authorId][myId] || { rating: null, buddy: false };
  room.votes[authorId][myId] = { rating: prev.rating, buddy: !prev.buddy };
  saveRoom(room);
}
document.getElementById('btnVoteUp').onclick = ()=>castVote(1);
document.getElementById('btnVoteNeutral').onclick = ()=>castVote(0);
document.getElementById('btnVoteDown').onclick = ()=>castVote(-1);
document.getElementById('btnMemeBuddy').onclick = ()=>toggleBuddy();

// Avanza al siguiente meme a votar, o si era el último, cierra la ronda de
// votación calculando todos los puntos de golpe (ver finalizeRoundScoring).
function advanceReveal(r){
  if(r.revealIndex + 1 < r.revealOrder.length){
    r.revealIndex += 1;
    r.voteEndsAt = Date.now() + (r.votingSeconds||30)*1000;
    r.voteAllInTriggered = false;
    saveRoom(r);
  }else{
    finalizeRoundScoring(r);
    r.status = 'roundend';
    // 30s para que todos vean/descarguen los memes; si todos se marcan
    // "listo" antes, se puede saltar la espera (ver checkAutoAdvanceRoundEnd).
    r.roundEndEndsAt = Date.now() + 30000;
    r.roundEndReady = {};
    saveRoom(r);
  }
}

document.getElementById('btnNextReveal').onclick = ()=>{
  room = loadRoom();
  advanceReveal(room);
};

// Avance automático de la votación: si se acaba el tiempo, o si todos los
// jugadores con derecho a voto ya reaccionaron (en cuyo caso se acorta el
// tiempo restante a solo 5s en vez de esperar el conteo completo).
function checkAutoAdvanceReveal(){
  if(!room || room.status !== 'reveal') return;
  if(!isHost()) return; // ver nota en checkAutoAdvanceCaption sobre la carrera entre clientes
  const authorId = currentRevealUserId();
  if(!authorId) return;

  const eligibleVoters = Object.keys(room.users).filter(uid => uid !== authorId);
  const votesForThis = room.votes[authorId] || {};
  const votedCount = eligibleVoters.filter(uid => votesForThis[uid] && votesForThis[uid].rating !== null && votesForThis[uid].rating !== undefined).length;
  const allVoted = eligibleVoters.length > 0 && votedCount >= eligibleVoters.length;

  if(allVoted && !room.voteAllInTriggered){
    room = loadRoom();
    if(room.status !== 'reveal' || currentRevealUserId() !== authorId || room.voteAllInTriggered) return;
    const shortEnd = Date.now() + 5000;
    if(!room.voteEndsAt || room.voteEndsAt > shortEnd) room.voteEndsAt = shortEnd;
    room.voteAllInTriggered = true;
    saveRoom(room);
    return;
  }

  if(!room.voteEndsAt || Date.now() < room.voteEndsAt) return;
  room = loadRoom();
  if(room.status !== 'reveal' || currentRevealUserId() !== authorId) return; // otra pestaña ya avanzó
  advanceReveal(room);
}

// Calcula TODOS los puntos de la ronda de una sola vez, al terminar de votar
// el último meme. Reglas:
//  - El autor de cada meme gana 200 pts por cada Momazo (👍) que reciba y
//    pierde 200 por cada ZZZ (👎) que reciba. "meh" no suma ni resta.
//  - Cualquier jugador puede darle "Meme Buddy" a un meme (independiente de
//    su propio voto). Por cada Momazo/ZZZ que ESE meme reciba de OTROS
//    jugadores (sin contar el propio voto del buddy), el buddy gana/pierde
//    50 pts. Puede haber más de un buddy por meme.
function finalizeRoundScoring(r){
  const perMeme = [];
  const perPlayer = {}; // uid -> { total, entries:[{reason, amount}] }
  function addDelta(uid, amount, reason){
    if(!uid || amount === 0) return;
    if(!perPlayer[uid]) perPlayer[uid] = { total: 0, entries: [] };
    perPlayer[uid].total += amount;
    perPlayer[uid].entries.push({ amount, reason });
  }

  r.revealOrder.forEach(authorId=>{
    const sub = r.submissions[authorId];
    if(!sub) return;
    const tpl = tplById(sub.templateId);
    const votesObj = r.votes[authorId] || {};
    const voterIds = Object.keys(votesObj);
    let ups=0, downs=0, mehs=0;
    voterIds.forEach(vid=>{
      const rating = votesObj[vid].rating;
      if(rating === 1) ups++;
      else if(rating === -1) downs++;
      else if(rating === 0) mehs++;
    });
    const authorPoints = (ups - downs) * 200;
    const authorName = (r.users[authorId]||{}).name || '??? (ya no está en la sala)';
    // Se registran por separado los Momazos y los ZZZ (en vez de un solo
    // monto neto) para poder mostrar un resumen corto tipo "+400 por
    // Momazos, -200 por ZZZ" en la pantalla de fin de ronda.
    if(ups > 0) addDelta(authorId, ups*200, 'Momazos');
    if(downs > 0) addDelta(authorId, -downs*200, 'ZZZ');

    // Bonificación de los Meme Buddies de este meme.
    voterIds.forEach(buddyId=>{
      if(!votesObj[buddyId].buddy) return;
      let otherUps=0, otherDowns=0;
      voterIds.forEach(otherId=>{
        if(otherId === buddyId) return;
        const rv = votesObj[otherId].rating;
        if(rv === 1) otherUps++;
        else if(rv === -1) otherDowns++;
      });
      const buddyPoints = (otherUps - otherDowns) * 50;
      if(buddyPoints !== 0){
        addDelta(buddyId, buddyPoints, 'Meme Buddy');
      }
    });

    perMeme.push({
      authorId, authorName, templateId: sub.templateId, texts: sub.texts,
      ups, downs, mehs, points: authorPoints
    });
  });

  Object.entries(perPlayer).forEach(([uid, d])=>{
    r.scores[uid] = (r.scores[uid]||0) + d.total;
  });
  perMeme.sort((a,b)=> b.points - a.points);
  r.lastRoundBreakdown = { perMeme, perPlayer };
}

// ---------- Round end / game end ----------
function renderScoreboard(container){
  container.innerHTML = '';
  const entries = Object.entries(room.scores).sort((a,b)=>b[1]-a[1]);
  entries.forEach(([uid, score], i)=>{
    const u = room.users[uid] || {name:'??? (salió de la sala)', avatar: DEFAULT_AVATAR};
    const row = document.createElement('div');
    row.className = 'scoreboard-row';
    const avatarHtml = `<img src="${u.avatar || DEFAULT_AVATAR}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;">`;
    row.innerHTML = `<div class="pos">${i+1}</div>${avatarHtml}<div style="flex:1;font-weight:600;">${escapeHtml(u.name)}</div><div style="font-weight:800;color:var(--accent);">${score} pts</div>`;
    container.appendChild(row);
  });
}

// Pantalla de cierre de ronda: puntaje total, detalle de por qué cada quien
// ganó/perdió puntos esta ronda, y la lista de memes de la ronda con botón
// de descarga.
function renderRoundEnd(){
  renderScoreboard(document.getElementById('roundScoreboard'));

  const breakdown = room.lastRoundBreakdown;
  const logBox = document.getElementById('roundPointLog');
  logBox.innerHTML = '';
  const playerEntries = breakdown ? Object.entries(breakdown.perPlayer) : [];
  if(playerEntries.length === 0){
    logBox.innerHTML = '<p class="muted">Nadie sumó ni restó puntos esta ronda.</p>';
  }else{
    playerEntries.sort((a,b)=> b[1].total - a[1].total).forEach(([uid, d])=>{
      const u = room.users[uid] || {name:'??? (salió de la sala)'};
      const row = document.createElement('div');
      row.className = 'log-player';
      const color = d.total >= 0 ? 'var(--accent3)' : 'var(--down)';
      // Agrupa las entradas por categoría (Momazos / ZZZ / Meme Buddy) y
      // suma los montos de cada una, para mostrar un resumen corto en vez
      // de una explicación larga y explícita de cada reacción.
      const grouped = {};
      d.entries.forEach(e=>{ grouped[e.reason] = (grouped[e.reason]||0) + e.amount; });
      const summary = Object.entries(grouped)
        .map(([label, amt])=> `${amt>0?'+':''}${amt} por ${label}`)
        .join(', ');
      row.innerHTML = `<div class="log-player-head">` +
        `<strong>${escapeHtml(u.name)}</strong>` +
        `<span style="color:${color};font-weight:800;">${d.total>0?'+':''}${d.total} pts</span>` +
        `<button class="log-toggle" type="button" aria-label="Ver detalle">▾</button>` +
        `</div>` +
        `<div class="log-summary hidden">${escapeHtml(summary)}</div>`;
      const toggleBtn = row.querySelector('.log-toggle');
      const summaryEl = row.querySelector('.log-summary');
      toggleBtn.onclick = ()=>{
        summaryEl.classList.toggle('hidden');
        toggleBtn.classList.toggle('open');
      };
      logBox.appendChild(row);
    });
  }

  const memeBox = document.getElementById('roundMemeList');
  memeBox.innerHTML = '';
  const memeResults = breakdown ? breakdown.perMeme : [];
  memeResults.forEach((m, idx)=>{
    const tpl = tplById(m.templateId);
    const div = document.createElement('div');
    div.className = 'meme-result-card';
    const color = m.points >= 0 ? 'var(--accent3)' : 'var(--down)';
    div.innerHTML = `<div class="template-stage meme-result-stage" id="memeResultStage${idx}"></div>
      <div class="meme-result-info">
        <div style="font-weight:700;">${escapeHtml(m.authorName)}</div>
        <div class="muted" style="font-size:13px;">👍 ${m.ups} &nbsp; ➖ ${m.mehs} &nbsp; 👎 ${m.downs}</div>
        <div style="font-weight:800;color:${color};margin:4px 0 8px;">${m.points>0?'+':''}${m.points} pts</div>
        <button class="ghost small" data-dl="${idx}">⬇️ Descargar meme</button>
      </div>`;
    memeBox.appendChild(div);
    if(tpl) renderCaptionStage(document.getElementById('memeResultStage'+idx), tpl, m.texts, false);
  });
  memeBox.querySelectorAll('button[data-dl]').forEach(btn=>{
    btn.onclick = ()=>{
      const m = memeResults[parseInt(btn.dataset.dl, 10)];
      const tpl = tplById(m.templateId);
      if(!tpl){ alert('Esta plantilla ya no existe, no se puede descargar.'); return; }
      downloadMeme(tpl, m.texts, `momazo-${m.authorName}-ronda${room.round}`);
    };
  });

  // Estado del botón "Listo" y del contador de jugadores listos.
  const totalUsers = Object.keys(room.users).length;
  const readyMap = room.roundEndReady || {};
  const readyCount = Object.keys(readyMap).filter(uid => readyMap[uid] && room.users[uid]).length;
  document.getElementById('roundEndReadyInfo').textContent = `${readyCount} de ${totalUsers} jugador(es) listo(s) para continuar.`;
  document.getElementById('btnRoundEndReady').classList.toggle('active', !!readyMap[myId]);
}

// ---------- Descarga de memes ----------
// Dibuja los recuadros de texto de una plantilla sobre un contexto de canvas
// ya preparado (imagen o frame de GIF ya dibujado de fondo). Se usa tanto
// para las imágenes estáticas (PNG) como para cada frame de un GIF animado.
function drawTextBoxesOnCanvas(ctx, tpl, texts, canvasWidth, canvasHeight){
  tpl.boxes.forEach((b,i)=>{
    const txt = (texts && texts[i]) ? texts[i].toUpperCase() : '';
    if(!txt) return;
    const boxX = canvasWidth * b.x/100;
    const boxY = canvasHeight * b.y/100;
    const boxW = canvasWidth * b.w/100;
    const boxH = canvasHeight * b.h/100;
    let fontSize = Math.max(8, canvasWidth * (b.fontSize||6)/100);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let lines = wrapCanvasText(ctx, txt, boxW, fontSize);
    let guard = 0;
    while(fontSize > 8 && lines.length * fontSize * 1.05 > boxH && guard < 60){
      fontSize -= 1;
      lines = wrapCanvasText(ctx, txt, boxW, fontSize);
      guard++;
    }
    ctx.font = `800 ${fontSize}px Arial, sans-serif`;
    const totalH = lines.length * fontSize * 1.05;
    let y = boxY + boxH/2 - totalH/2 + fontSize/2;
    ctx.lineWidth = Math.max(2, fontSize*0.12);
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fff';
    lines.forEach(line=>{
      ctx.strokeText(line, boxX+boxW/2, y);
      ctx.fillText(line, boxX+boxW/2, y);
      y += fontSize*1.05;
    });
  });
}

function downloadMeme(tpl, texts, filename){
  const isGif = typeof tpl.image === 'string' && tpl.image.startsWith('data:image/gif');
  if(isGif){
    downloadAnimatedGifWithText(tpl, texts, filename);
    return;
  }
  const img = new Image();
  img.onload = ()=>{
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 600;
    canvas.height = img.naturalHeight || 600;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    drawTextBoxesOnCanvas(ctx, tpl, texts, canvas.width, canvas.height);
    canvas.toBlob(blob=>{
      const url = URL.createObjectURL(blob);
      triggerDownload(url, filename + '.png');
      setTimeout(()=>URL.revokeObjectURL(url), 5000);
    }, 'image/png');
  };
  img.src = tpl.image;
}

// Incrusta el texto sobre un GIF animado: decodifica cada frame original con
// gifuct-js, dibuja ese frame + el texto sobre un canvas, y junta todos los
// frames de nuevo en un GIF animado nuevo con gif.js. Si alguna de las dos
// librerías externas no cargó (por ejemplo, sin conexión a internet ya que
// se sirven desde un CDN), se avisa y se descarga el GIF original sin texto.
function downloadAnimatedGifWithText(tpl, texts, filename){
  if(typeof GIF === 'undefined' || typeof gifuct === 'undefined'){
    triggerDownload(tpl.image, filename + '.gif');
    alert('No se pudieron cargar las librerías para incrustar texto en GIFs (revisa tu conexión a internet). Se descargó el GIF original, sin texto.');
    return;
  }
  fetch(tpl.image)
    .then(res => res.arrayBuffer())
    .then(buffer=>{
      const gifData = gifuct.parseGIF(buffer);
      const frames = gifuct.decompressFrames(gifData, true);
      if(!frames.length) throw new Error('El GIF no tiene frames.');

      const width = gifData.lsd.width;
      const height = gifData.lsd.height;

      const encoder = new GIF({
        workers: 2,
        quality: 10,
        width, height,
        workerScript: 'https://cdn.jsdelivr.net/npm/gif.js.optimized@1.0.1/dist/gif.worker.js'
      });

      // Canvas "base" que va acumulando los frames tal como se dibujarían al
      // reproducir el GIF (respeta el disposalType de cada frame).
      const baseCanvas = document.createElement('canvas');
      baseCanvas.width = width; baseCanvas.height = height;
      const baseCtx = baseCanvas.getContext('2d');

      frames.forEach(frame=>{
        if(frame.disposalType === 2){
          baseCtx.clearRect(0, 0, width, height);
        }
        const dims = frame.dims;
        const frameImageData = baseCtx.createImageData(dims.width, dims.height);
        frameImageData.data.set(frame.patch);
        baseCtx.putImageData(frameImageData, dims.left, dims.top);

        // Se copia el frame compuesto a un canvas de salida y ahí se dibuja
        // el texto encima, para no alterar el canvas base que sigue
        // acumulando los siguientes frames.
        const outCanvas = document.createElement('canvas');
        outCanvas.width = width; outCanvas.height = height;
        const outCtx = outCanvas.getContext('2d');
        outCtx.drawImage(baseCanvas, 0, 0);
        drawTextBoxesOnCanvas(outCtx, tpl, texts, width, height);

        // frame.delay viene en centésimas de segundo (spec del GIF); gif.js
        // espera milisegundos.
        encoder.addFrame(outCtx, { copy: true, delay: (frame.delay || 10) * 10 });
      });

      encoder.on('finished', blob=>{
        const url = URL.createObjectURL(blob);
        triggerDownload(url, filename + '.gif');
        setTimeout(()=>URL.revokeObjectURL(url), 8000);
      });
      encoder.render();
    })
    .catch(err=>{
      console.error('No se pudo incrustar el texto en el GIF', err);
      triggerDownload(tpl.image, filename + '.gif');
      alert('No se pudo incrustar el texto en este GIF, se descargó el original sin texto.');
    });
}

function wrapCanvasText(ctx, text, maxWidth, fontSize){
  ctx.font = `800 ${fontSize}px Arial, sans-serif`;
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  words.forEach(w=>{
    const test = cur ? cur+' '+w : w;
    if(cur && ctx.measureText(test).width > maxWidth){
      lines.push(cur);
      cur = w;
    }else{
      cur = test;
    }
  });
  if(cur) lines.push(cur);
  return lines.length ? lines : [text];
}

function triggerDownload(href, filename){
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Avanza desde la pantalla de fin de ronda hacia la siguiente ronda (o al
// cierre de la partida si ya no quedan rondas). Se llama tanto cuando se
// acaban los 30s como cuando todos los jugadores ya se marcaron "listo".
function advanceFromRoundEnd(r){
  if(r.round >= r.totalRounds){
    r.status = 'gameend';
    r.roundEndEndsAt = null;
    r.roundEndReady = {};
    saveRoom(r);
  }else{
    startRound(r, false);
  }
}

document.getElementById('btnRoundEndReady').onclick = ()=>{
  room = loadRoom();
  if(!room.roundEndReady) room.roundEndReady = {};
  room.roundEndReady[myId] = !room.roundEndReady[myId];
  saveRoom(room);
};

// Avance automático de la pantalla de fin de ronda: se dispara cuando se
// acaban los 30 segundos, o antes si TODOS los jugadores conectados ya se
// marcaron como "listos" (así se puede saltar la espera para jugar rápido).
function checkAutoAdvanceRoundEnd(){
  if(!room || room.status !== 'roundend') return;
  if(!isHost()) return; // ver nota en checkAutoAdvanceCaption sobre la carrera entre clientes
  const totalUsers = Object.keys(room.users).length;
  const readyMap = room.roundEndReady || {};
  const readyCount = Object.keys(readyMap).filter(uid => readyMap[uid] && room.users[uid]).length;
  const allReady = totalUsers > 0 && readyCount >= totalUsers;
  const timeUp = room.roundEndEndsAt && Date.now() >= room.roundEndEndsAt;
  if(!allReady && !timeUp) return;
  room = loadRoom();
  if(room.status !== 'roundend') return; // otra pestaña ya avanzó
  advanceFromRoundEnd(room);
}

document.getElementById('btnBackToLobbyFinal').onclick = ()=>{
  room = loadRoom();
  room.status = 'lobby';
  room.round = 0;
  room.submissions = {};
  room.votes = {};
  room.revealOrder = [];
  room.revealIndex = 0;
  room.voteEndsAt = null;
  room.voteAllInTriggered = false;
  room.lastRoundBreakdown = null;
  room.roundEndEndsAt = null;
  room.roundEndReady = {};
  saveRoom(room);
};

// ---------- Render general / navegación de pantallas ----------
const SCREENS = ['login','lobby','settings','caption','reveal','roundend','gameend'];
function showScreen(name){
  SCREENS.forEach(s=>{
    document.getElementById('screen-'+s).classList.toggle('hidden', s !== name);
  });
}

function renderLobby(){
  const list = document.getElementById('userList');
  list.innerHTML = '';
  Object.entries(room.users).forEach(([uid,u])=>{
    const row = document.createElement('div');
    row.className = 'user-row';
    const avatarHtml = u.avatar.startsWith('data:') ? `<img src="${u.avatar}" style="width:100%;height:100%;object-fit:cover;">` : u.avatar;
    row.innerHTML = `<div class="avatar">${avatarHtml}</div><div class="name">${escapeHtml(u.name)}${uid===room.hostId?' 👑':''}</div><div class="score">${room.scores[uid]||0} pts</div>`;
    list.appendChild(row);
  });
  document.getElementById('lobbyInfo').textContent = `${templates.length} plantilla(s) disponibles · ${room.totalRounds} rondas · ${room.roundSeconds}s por ronda`;
  if(isHost()){
    const canStart = templates.length > 0;
    document.getElementById('btnStartGame').disabled = !canStart;
    document.getElementById('startHint').textContent = templates.length===0 ? 'Agrega una plantilla en Configuración antes de iniciar.' : '';
  }else{
    document.getElementById('startHint').textContent = 'Esperando a que el anfitrión 👑 inicie la partida...';
  }
}

function updateTimerDisplay(){
  if(room && room.status === 'caption' && room.roundEndsAt){
    const remaining = Math.max(0, Math.round((room.roundEndsAt - Date.now())/1000));
    const mm = String(Math.floor(remaining/60)).padStart(2,'0');
    const ss = String(remaining%60).padStart(2,'0');
    const el = document.getElementById('captionTimer');
    if(el) el.textContent = `${mm}:${ss}`;
  }
  if(room && room.status === 'reveal' && room.voteEndsAt){
    const remaining = Math.max(0, Math.round((room.voteEndsAt - Date.now())/1000));
    const el = document.getElementById('revealTimer');
    if(el) el.textContent = `${String(remaining).padStart(2,'0')}s`;
  }
  if(room && room.status === 'roundend' && room.roundEndEndsAt){
    const remaining = Math.max(0, Math.round((room.roundEndEndsAt - Date.now())/1000));
    const el = document.getElementById('roundEndTimer');
    if(el) el.textContent = `${String(remaining).padStart(2,'0')}s`;
  }
}

function render(){
  if(!joined){ showScreen('login'); return; }
  if(!room) return;

  updateHostControls();

  // Si un jugador que no es anfitrión llegó a quedar con la pantalla de
  // configuración abierta (por ejemplo, era anfitrión y perdió ese rol
  // porque otra pestaña lo reasignó), lo sacamos de ahí automáticamente.
  const settingsVisible = !document.getElementById('screen-settings').classList.contains('hidden');
  if(settingsVisible){
    if(!isHost()){ showScreen('lobby'); renderLobby(); return; }
    renderTemplateThumbs();
    return;
  }

  switch(room.status){
    case 'lobby':
      showScreen('lobby'); renderLobby(); break;
    case 'caption':
      showScreen('caption'); renderCaptionScreen(); checkAutoAdvanceCaption(); break;
    case 'reveal':
      showScreen('reveal'); renderRevealScreen(); checkAutoAdvanceReveal(); break;
    case 'roundend':
      showScreen('roundend'); renderRoundEnd(); checkAutoAdvanceRoundEnd(); break;
    case 'gameend':
      showScreen('gameend'); renderScoreboard(document.getElementById('finalScoreboard')); break;
    default:
      showScreen('lobby'); renderLobby();
  }
}

function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// ---------- Sincronización en tiempo real con Firebase ----------
// A diferencia del sondeo (setInterval) que usábamos con localStorage, acá
// Firebase EMPUJA los cambios apenas ocurren — no hay que preguntar cada
// cierto tiempo. `firebaseSynced` evita que alguien pueda "entrar a la
// sala" antes de que llegue el primer dato real desde Firebase, lo cual
// podría sobrescribir por accidente la sala de otros jugadores ya
// conectados con una sala vacía.
let firebaseSynced = { room: false, templates: false };

function checkFirebaseReadyForJoin(){
  const ready = firebaseSynced.room && firebaseSynced.templates;
  const btn = document.getElementById('btnJoin');
  if(btn){
    btn.disabled = !ready;
    btn.textContent = ready ? 'Entrar a la sala' : 'Conectando...';
  }
}

dbRoomRef.on('value', snapshot=>{
  const val = snapshot.val();
  room = normalizeRoom(val);
  if(ensureValidHost(room)) saveRoom(room);
  firebaseSynced.room = true;
  checkFirebaseReadyForJoin();
  render();
}, error=>{
  console.error('Error de conexión con Firebase (sala):', error);
});

dbTplRef.on('value', snapshot=>{
  const val = snapshot.val();
  templates = (val && val.length) ? val : builtinTemplates();
  firebaseSynced.templates = true;
  checkFirebaseReadyForJoin();
  render();
}, error=>{
  console.error('Error de conexión con Firebase (plantillas):', error);
});

// Los avances automáticos por tiempo (fin de turno de captión, de votación,
// de la pantalla de resultados) dependen del reloj, no de que llegue un
// dato nuevo de Firebase — por eso seguimos re-evaluando render() cada
// segundo además de reaccionar a los cambios en tiempo real de arriba.
// Esto NO genera lecturas de red: solo reutiliza la copia local ya
// sincronizada.
setInterval(()=>{ if(joined) render(); }, 1000);
setInterval(updateTimerDisplay, 500);

checkFirebaseReadyForJoin();
showScreen('login');
