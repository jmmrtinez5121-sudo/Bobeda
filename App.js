import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, Image, Alert, TextInput, ScrollView, Modal, Switch, AppState, StatusBar as RNStatusBar, ActivityIndicator, Dimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as LocalAuth from 'expo-local-authentication';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FS from 'expo-file-system/legacy';
import * as ML from 'expo-media-library/legacy';
import * as DocPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as ScreenCapture from 'expo-screen-capture';
import { zipWithPassword, unzipWithPassword } from 'react-native-zip-archive';

const C = { bg: '#060b18', card: '#0e1830', ink: '#e6f3ff', mute: '#8aa4c4', line: '#1c3358', acc: '#2de2e6', on: '#04121c', bad: '#ff6b8b', ok: '#5dffb0' };
const T = { photo: ['Fotos', '🖼️'], video: ['Videos', '🎬'], music: ['Música', '🎵'], doc: ['Documentos', '📄'], apk: ['Apps (APK)', '📦'], other: ['Otros', '📁'] };
const MEDIA = ['photo', 'video', 'music'];
const P = (u) => u.replace('file://', '');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmt = (iso) => new Date(iso).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

const paths = (m) => { const r = FS.documentDirectory + (m === 'decoy' ? 'decoy/' : 'vault/'); return { root: r, files: r + 'files/', intr: r + 'intr/', index: r + 'index.json' }; };
async function ensure(m) { const p = paths(m); for (const d of [p.root, p.files, p.intr]) { const i = await FS.getInfoAsync(d); if (!i.exists) await FS.makeDirectoryAsync(d, { intermediates: true }); } return p; }
const emptyDb = () => ({ items: [], trash: [], intr: [] });
async function readDb(m) { const p = await ensure(m); const i = await FS.getInfoAsync(p.index); if (!i.exists) return emptyDb(); try { return { ...emptyDb(), ...JSON.parse(await FS.readAsStringAsync(p.index)) }; } catch (e) { return emptyDb(); } }
const writeDb = (m, d) => FS.writeAsStringAsync(paths(m).index, JSON.stringify(d));
const hash = (pin, salt) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, salt + pin);
const sget = async (k) => { try { const v = await SecureStore.getItemAsync(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
const sset = (k, v) => SecureStore.setItemAsync(k, JSON.stringify(v));
const setPin = async (key, pin) => { const salt = uid(); await sset(key, { salt, h: await hash(pin, salt) }); };
const checkPin = async (key, pin) => { const r = await sget(key); return !!r && (await hash(pin, r.salt)) === r.h; };
const DEF = { fp: false, autolock: true, noshot: true, decoy: false, autobk: false, lastBackup: 0 };

/* ---------- Teclado PIN ---------- */
function PinPad({ title, sub, err, disabled, onPin, onBio, onCancel }) {
  const [v, setV] = useState('');
  useEffect(() => { if (v.length === 4) { const x = v; const t = setTimeout(() => { setV(''); onPin(x); }, 150); return () => clearTimeout(t); } }, [v]);
  const press = (k) => { if (disabled) return; if (k === '<') setV((x) => x.slice(0, -1)); else setV((x) => (x.length < 4 ? x + k : x)); };
  return (
    <View style={[s.center, disabled && { opacity: 0.5 }]}>
      <Text style={s.dial}>🔒</Text>
      <Text style={s.h1}>{title}</Text>
      <Text style={[s.sub, err && { color: C.bad }]}>{sub || ' '}</Text>
      <View style={s.dots}>{[0, 1, 2, 3].map((i) => <View key={i} style={[s.dot, i < v.length && { backgroundColor: C.acc }]} />)}</View>
      <View style={s.pad}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', onBio ? 'bio' : '', '0', '<'].map((k, i) => k === '' ? <View key={i} style={s.key} /> : (
          <TouchableOpacity key={i} style={s.key} onPress={() => (k === 'bio' ? onBio() : press(k))} accessibilityLabel={k === 'bio' ? 'Usar huella' : k === '<' ? 'Borrar' : k}>
            <Text style={s.keyT}>{k === 'bio' ? '☝️' : k === '<' ? '⌫' : k}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {onCancel && <TouchableOpacity onPress={onCancel} style={{ marginTop: 20 }}><Text style={{ color: C.mute, fontSize: 16 }}>Cancelar</Text></TouchableOpacity>}
    </View>
  );
}

function PinSetup({ title, onDone, onCancel }) {
  const [first, setFirst] = useState(null); const [err, setErr] = useState(false);
  return <PinPad title={title} err={err} onCancel={onCancel}
    sub={err ? 'Los PIN no coinciden. Intenta de nuevo.' : first ? 'Escríbelo otra vez para confirmar' : 'Elige 4 dígitos. Si lo olvidas, no hay forma de recuperarlo.'}
    onPin={(p) => { if (!first) { setFirst(p); setErr(false); } else if (p === first) onDone(p); else { setFirst(null); setErr(true); } }} />;
}

const Btn = ({ label, onPress, main, disabled, style }) => (
  <TouchableOpacity disabled={disabled} onPress={onPress} style={[s.btn, main && s.btnMain, disabled && { opacity: 0.4 }, style]}>
    <Text style={[s.btnT, main && { color: C.on, fontWeight: '700' }]}>{label}</Text>
  </TouchableOpacity>
);

function PassModal({ title, onOk, onCancel }) {
  const [v, setV] = useState('');
  return (
    <Modal transparent animationType="fade" onRequestClose={onCancel}>
      <View style={s.veil}><View style={s.sheet}>
        <Text style={s.h3}>{title}</Text>
        <TextInput style={s.input} secureTextEntry value={v} onChangeText={setV} placeholder="Contraseña (mínimo 6 caracteres)" placeholderTextColor={C.mute} autoCapitalize="none" />
        <Btn main label="Continuar" disabled={v.length < 6} onPress={() => onOk(v)} />
        <Btn label="Cancelar" onPress={onCancel} />
      </View></View>
    </Modal>
  );
}

/* ---------- Pantalla de bloqueo ---------- */
function Lock({ S, lk, setLk, onOpen, busy }) {
  const cam = useRef(null); const ready = useRef(false);
  const [perm, req] = useCameraPermissions();
  const [msg, setMsg] = useState(''); const [, force] = useState(0);
  useEffect(() => { if (perm && !perm.granted && perm.canAskAgain) busy(() => req()); }, [perm && perm.granted]);
  useEffect(() => { const t = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const left = Math.ceil((lk.until - Date.now()) / 1000); const locked = left > 0;
  const okOpen = (m) => { setLk({ fails: 0, until: 0 }); sset('lk', { fails: 0, until: 0 }); onOpen(m); };
  const bio = () => { if (locked) return; busy(async () => { const r = await LocalAuth.authenticateAsync({ promptMessage: 'Abrir bóveda', cancelLabel: 'Usar PIN', disableDeviceFallback: true }); if (r.success) okOpen('real'); }); };
  useEffect(() => { if (S.fp) { const t = setTimeout(bio, 400); return () => clearTimeout(t); } }, []);
  async function snap() {
    try {
      if (!cam.current || !ready.current) return;
      const ph = await cam.current.takePictureAsync({ quality: 0.4, shutterSound: false });
      const p = await ensure('real'); const id = uid();
      await FS.copyAsync({ from: ph.uri, to: p.intr + id + '.jpg' });
      const d = await readDb('real'); d.intr.unshift({ id, t: new Date().toISOString(), file: id + '.jpg' }); await writeDb('real', d);
    } catch (e) { /* sin foto */ }
  }
  const tryPin = async (pin) => {
    if (locked) return;
    if (await checkPin('pin', pin)) return okOpen('real');
    if (S.decoy && (await checkPin('dpin', pin))) return okOpen('decoy');
    snap();
    const fails = lk.fails + 1; const until = fails >= 3 ? Date.now() + Math.min(30 * 2 ** (fails - 3), 300) * 1000 : 0;
    const n = { fails, until }; setLk(n); sset('lk', n); setMsg('PIN incorrecto. Se guardó una foto del intento.');
  };
  return (
    <View style={s.root}>
      {perm && perm.granted && <CameraView ref={cam} facing="front" style={{ position: 'absolute', width: 2, height: 2, top: 0, left: 0, opacity: 0.01 }} onCameraReady={() => { ready.current = true; }} />}
      <PinPad title="Bóveda" err={!!msg || locked} disabled={locked} sub={locked ? `Demasiados intentos. Espera ${left} s.` : msg || 'Escribe tu PIN para entrar'} onPin={tryPin} onBio={S.fp ? bio : null} />
    </View>
  );
}

/* ---------- Selector de galería ---------- */
function MediaPicker({ kind, busy, onClose, onDone }) {
  const [as, setAs] = useState([]); const [sel, setSel] = useState({}); const [cur, setCur] = useState(null); const [more, setMore] = useState(false); const [ok, setOk] = useState(true);
  const w = Dimensions.get('window').width / 3;
  const load = async (after) => { const r = await ML.getAssetsAsync({ mediaType: kind, first: 60, after }); setAs((a) => (after ? [...a, ...r.assets] : r.assets)); setCur(r.endCursor); setMore(r.hasNextPage); };
  useEffect(() => { (async () => { const r = await busy(() => ML.requestPermissionsAsync()); if (!r || !r.granted) { setOk(false); return; } load(); })(); }, []);
  const chosen = as.filter((a) => sel[a.id]);
  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <View style={[s.root, { paddingHorizontal: 0 }]}>
        <Text style={[s.h2, { padding: 16 }]}>Elige {T[kind][0].toLowerCase()} para guardar</Text>
        {!ok && <Text style={s.empty}>Sin permiso para ver la galería. Actívalo en los ajustes de la app.</Text>}
        <FlatList data={as} numColumns={3} keyExtractor={(a) => a.id} onEndReached={() => more && load(cur)} style={{ flex: 1 }}
          renderItem={({ item }) => (
            <TouchableOpacity onPress={() => setSel((x) => ({ ...x, [item.id]: !x[item.id] }))} style={{ width: w, height: w, padding: 1 }}>
              {kind === 'music' ? <View style={[s.ph, { backgroundColor: C.card }]}><Text style={{ fontSize: 22 }}>🎵</Text><Text numberOfLines={2} style={{ color: C.ink, fontSize: 11, textAlign: 'center' }}>{item.filename}</Text></View>
                : <Image source={{ uri: item.uri }} style={{ flex: 1, backgroundColor: C.card }} />}
              {sel[item.id] && <View style={s.tick}><Text style={{ color: C.on, fontWeight: '700' }}>✓</Text></View>}
            </TouchableOpacity>
          )} />
        <View style={{ padding: 16 }}>
          <Btn main label={`Guardar y quitar de la galería (${chosen.length})`} disabled={!chosen.length} onPress={() => onDone(chosen)} />
          <Btn label="Cancelar" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function Player({ uri }) { const pl = useVideoPlayer(uri, (x) => { x.play(); }); return <VideoView player={pl} style={{ width: '100%', height: 300 }} nativeControls allowsFullscreen />; }

function Viewer({ item, p, busy, onClose, onTrash, onOut }) {
  const uri = p.files + item.file;
  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <View style={[s.root, { paddingHorizontal: 0 }]}>
        <View style={{ flex: 1, justifyContent: 'center', backgroundColor: '#000' }}>
          {item.type === 'photo' && <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />}
          {(item.type === 'video' || item.type === 'music') && <Player uri={uri} />}
          {!MEDIA.includes(item.type) && <Text style={{ fontSize: 64, textAlign: 'center' }}>{T[item.type][1]}</Text>}
        </View>
        <View style={{ padding: 16 }}>
          <Text style={s.h3} numberOfLines={2}>{item.name}</Text>
          <Text style={s.sub}>{mb(item.size)} · guardado {fmt(item.t)}</Text>
          {!MEDIA.includes(item.type) && <Btn main label="Abrir con otra app" onPress={() => busy(() => Sharing.shareAsync(uri))} />}
          <Btn label={MEDIA.includes(item.type) ? 'Sacar de la bóveda (volver a la galería)' : 'Compartir o guardar copia'} onPress={() => (MEDIA.includes(item.type) ? onOut() : busy(() => Sharing.shareAsync(uri)))} />
          <Btn label="Mover a la papelera" onPress={onTrash} />
          <Btn label="Cerrar" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

/* ---------- Pestaña Bóveda ---------- */
function Vault({ db, commit, p, busy, S }) {
  const [cat, setCat] = useState('all'), [q, setQ] = useState(''), [sort, setSort] = useState('date'), [sm, setSm] = useState(false), [sel, setSel] = useState([]);
  const [view, setView] = useState(null), [menu, setMenu] = useState(false), [kind, setKind] = useState(null), [tr, setTr] = useState(false);
  let l = db.items.filter((i) => (cat === 'all' || i.type === cat) && i.name.toLowerCase().includes(q.toLowerCase()));
  l = [...l].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'size' ? b.size - a.size : b.t.localeCompare(a.t)));
  const tot = db.items.reduce((a, i) => a + i.size, 0);
  const days = S.lastBackup ? Math.floor((Date.now() - S.lastBackup) / 864e5) : null;
  const w = (Dimensions.get('window').width - 32) / 3;

  const toTrash = (ids) => { commit({ ...db, items: db.items.filter((i) => !ids.includes(i.id)), trash: [...db.items.filter((i) => ids.includes(i.id)), ...db.trash] }); setSel([]); setSm(false); setView(null); };
  const takeOut = async (ids) => {
    const moved = [];
    await busy(async () => {
      try { const r = await ML.requestPermissionsAsync(); if (!r.granted) { Alert.alert('Sin permiso', 'Activa el permiso de la galería para devolver archivos.'); return; } } catch (e) { return; }
      for (const i of db.items.filter((x) => ids.includes(x.id) && MEDIA.includes(x.type))) {
        try { await ML.createAssetAsync(p.files + i.file); await FS.deleteAsync(p.files + i.file, { idempotent: true }); moved.push(i.id); } catch (e) { /* se queda */ }
      }
    });
    if (moved.length) commit({ ...db, items: db.items.filter((i) => !moved.includes(i.id)) });
    setSel([]); setSm(false); setView(null);
    Alert.alert(moved.length ? 'Listo' : 'No se pudo', moved.length ? `${moved.length} archivo(s) devueltos a la galería.` : 'Solo fotos, videos y música pueden volver a la galería.');
  };
  const importAssets = async (assets, type) => {
    setKind(null);
    await busy(async () => {
      const added = [];
      for (const a of assets) {
        try {
          const id = uid(); const ext = (a.filename.split('.').pop() || 'bin'); const file = id + '.' + ext;
          await FS.copyAsync({ from: a.uri, to: p.files + file });
          const inf = await FS.getInfoAsync(p.files + file);
          added.push({ id, name: a.filename, type, size: inf.size || 0, t: new Date().toISOString(), file });
        } catch (e) { /* omitido */ }
      }
      if (!added.length) { Alert.alert('No se pudo guardar', 'No se pudieron copiar los archivos.'); return; }
      commit({ ...db, items: [...added, ...db.items] });
      let ok = false; try { ok = await ML.deleteAssetsAsync(assets); } catch (e) { /* sin confirmar */ }
      Alert.alert(ok ? 'Listo' : 'Guardado en la bóveda', ok ? `${added.length} archivo(s) guardados y quitados de la galería.` : 'Se guardaron, pero siguen en la galería porque no confirmaste el borrado. Puedes borrarlos desde la galería.');
    });
  };
  const pickDocs = async (type) => {
    setMenu(false);
    await busy(async () => {
      const r = await DocPicker.getDocumentAsync({ type: type === 'apk' ? 'application/vnd.android.package-archive' : '*/*', multiple: true, copyToCacheDirectory: true });
      if (r.canceled) return; const added = [];
      for (const a of r.assets) {
        try {
          const id = uid(); const ext = a.name.includes('.') ? a.name.split('.').pop() : 'bin'; const file = id + '.' + ext;
          await FS.copyAsync({ from: a.uri, to: p.files + file }); await FS.deleteAsync(a.uri, { idempotent: true });
          added.push({ id, name: a.name, type, size: a.size || 0, t: new Date().toISOString(), file });
        } catch (e) { /* omitido */ }
      }
      if (added.length) { commit({ ...db, items: [...added, ...db.items] }); Alert.alert('Guardado', 'Los documentos no están en la galería. Si quieres, borra el original desde tu carpeta de Descargas.'); }
    });
  };
  const tap = (i) => { if (sm) setSel((x) => (x.includes(i.id) ? x.filter((y) => y !== i.id) : [...x, i.id])); else setView(i); };
  const row = (i) => (
    <TouchableOpacity key={i.id} style={[s.item, sel.includes(i.id) && { borderColor: C.acc }]} onPress={() => tap(i)}>
      {sm && <Text style={{ color: C.acc, fontSize: 20, marginRight: 8 }}>{sel.includes(i.id) ? '☑' : '☐'}</Text>}
      <Text style={{ fontSize: 22, marginRight: 10 }}>{T[i.type][1]}</Text>
      <View style={{ flex: 1 }}><Text style={s.itemT} numberOfLines={1}>{i.name}</Text><Text style={s.sub}>{mb(i.size)} · {fmt(i.t)}</Text></View>
    </TouchableOpacity>
  );
  return (
    <View style={{ flex: 1 }}>
      {S.autobk && (days === null || days >= 7) && <Text style={s.warn}>{days === null ? 'Aún no has hecho un respaldo.' : `Hace ${days} días que no haces un respaldo.`}</Text>}
      <Text style={s.sub}>{db.items.length ? `${db.items.length} archivos protegidos · ${mb(tot)} ocupados` : ' '}</Text>
      <View style={s.tool}>
        <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} value={q} onChangeText={setQ} placeholder="Buscar archivo" placeholderTextColor={C.mute} />
        <Btn label={{ date: 'Recientes', name: 'Nombre', size: 'Tamaño' }[sort]} style={s.small} onPress={() => setSort({ date: 'name', name: 'size', size: 'date' }[sort])} />
      </View>
      <View style={s.tool}>
        <Btn label={sm ? 'Cancelar' : 'Seleccionar'} style={s.small} onPress={() => { setSm(!sm); setSel([]); }} />
        <Btn label={`🗑️ ${db.trash.length}`} style={s.small} onPress={() => setTr(true)} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginBottom: 8 }}>
        {['all', ...Object.keys(T)].map((k) => <TouchableOpacity key={k} onPress={() => setCat(k)} style={[s.chip, cat === k && s.chipOn]}><Text style={{ color: cat === k ? C.on : C.ink }}>{k === 'all' ? 'Todo' : T[k][0]}</Text></TouchableOpacity>)}
      </ScrollView>
      <ScrollView style={{ flex: 1 }}>
        {!l.length && <Text style={s.empty}>{db.items.length ? 'No hay archivos que mostrar.' : 'Tu bóveda está vacía.\nToca “+ Agregar” para guardar tu primer archivo.'}</Text>}
        {cat === 'photo' ? <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{l.map((i) => (
          <TouchableOpacity key={i.id} onPress={() => tap(i)} style={{ width: w, height: w, padding: 1 }}>
            <Image source={{ uri: p.files + i.file }} style={{ flex: 1, backgroundColor: C.card }} />
            {sel.includes(i.id) && <View style={s.tick}><Text style={{ color: C.on, fontWeight: '700' }}>✓</Text></View>}
          </TouchableOpacity>))}</View> : l.map(row)}
        <View style={{ height: 90 }} />
      </ScrollView>
      {sm && sel.length > 0 ? (
        <View style={s.bulk}><Btn label="Sacar" style={{ flex: 1 }} onPress={() => takeOut(sel)} /><Btn label="A la papelera" style={{ flex: 1 }} onPress={() => toTrash(sel)} /></View>
      ) : !sm && <TouchableOpacity style={s.fab} onPress={() => setMenu(true)}><Text style={{ color: C.on, fontWeight: '700' }}>+ Agregar</Text></TouchableOpacity>}

      {menu && <Modal transparent animationType="fade" onRequestClose={() => setMenu(false)}><View style={s.veil}><View style={s.sheet}>
        <Text style={s.h3}>¿Qué quieres guardar?</Text>
        {Object.keys(T).map((k) => <Btn key={k} label={`${T[k][1]}  ${T[k][0]}`} onPress={() => { setMenu(false); MEDIA.includes(k) ? setKind(k) : pickDocs(k); }} />)}
        <Btn label="Cancelar" onPress={() => setMenu(false)} />
      </View></View></Modal>}
      {kind && <MediaPicker kind={kind} busy={busy} onClose={() => setKind(null)} onDone={(a) => importAssets(a, kind)} />}
      {view && <Viewer item={view} p={p} busy={busy} onClose={() => setView(null)} onTrash={() => toTrash([view.id])} onOut={() => takeOut([view.id])} />}
      {tr && <Modal animationType="slide" onRequestClose={() => setTr(false)}><View style={s.root}>
        <Text style={s.h2}>Papelera</Text>
        <ScrollView style={{ flex: 1 }}>
          {!db.trash.length && <Text style={s.empty}>La papelera está vacía.</Text>}
          {db.trash.map((i) => <View key={i.id} style={s.item}><Text style={{ fontSize: 22, marginRight: 10 }}>{T[i.type][1]}</Text><View style={{ flex: 1 }}><Text style={s.itemT} numberOfLines={1}>{i.name}</Text><Text style={s.sub}>{mb(i.size)}</Text></View>
            <Btn label="Recuperar" style={s.small} onPress={() => commit({ ...db, trash: db.trash.filter((x) => x.id !== i.id), items: [i, ...db.items] })} /></View>)}
        </ScrollView>
        <Btn label="Vaciar papelera (borra para siempre)" disabled={!db.trash.length} onPress={() => Alert.alert('¿Borrar para siempre?', 'No se podrá recuperar.', [{ text: 'Cancelar' }, { text: 'Borrar', style: 'destructive', onPress: async () => { for (const i of db.trash) await FS.deleteAsync(p.files + i.file, { idempotent: true }); commit({ ...db, trash: [] }); } }])} />
        <Btn label="Cerrar" onPress={() => setTr(false)} />
      </View></Modal>}
    </View>
  );
}

/* ---------- Intrusos ---------- */
function Intruders({ db, commit, p }) {
  return (
    <ScrollView style={{ flex: 1 }}>
      <Text style={s.sub}>Fotos con la cámara frontal cuando alguien escribió un PIN incorrecto.</Text>
      {!db.intr.length && <Text style={s.empty}>Sin intrusos. Aquí aparecerá la foto de quien falle el PIN.</Text>}
      {db.intr.map((x) => <View key={x.id} style={s.item}><Image source={{ uri: p.intr + x.file }} style={{ width: 70, height: 70, borderRadius: 8, marginRight: 12, backgroundColor: C.card }} /><View><Text style={s.itemT}>Intento fallido</Text><Text style={s.sub}>{fmt(x.t)}</Text></View></View>)}
      {db.intr.length > 0 && <Btn label="Borrar todas las fotos" onPress={async () => { for (const x of db.intr) await FS.deleteAsync(p.intr + x.file, { idempotent: true }); commit({ ...db, intr: [] }); }} />}
    </ScrollView>
  );
}

/* ---------- Respaldo ---------- */
function Backup({ db, commit, p, busy, S, saveS }) {
  const [pw, setPw] = useState(null); const [uri, setUri] = useState(null);
  const make = async (pass) => {
    setPw(null);
    await busy(async () => {
      try {
        const out = FS.cacheDirectory + `boveda-${new Date().toISOString().slice(0, 10)}.zip`;
        await FS.deleteAsync(out, { idempotent: true });
        await zipWithPassword(P(p.root), P(out), pass, 'AES-256');
        await Sharing.shareAsync(out, { mimeType: 'application/zip', dialogTitle: 'Guardar respaldo' });
        saveS({ ...S, lastBackup: Date.now() });
      } catch (e) { Alert.alert('No se pudo crear el respaldo', String((e && e.message) || e)); }
    });
  };
  const pick = () => busy(async () => { const r = await DocPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true }); if (!r.canceled) { setUri(r.assets[0].uri); setPw('restore'); } });
  const restore = async (pass) => {
    setPw(null);
    await busy(async () => {
      const tmp = FS.cacheDirectory + 'restore/';
      try {
        await FS.deleteAsync(tmp, { idempotent: true }); await FS.makeDirectoryAsync(tmp, { intermediates: true });
        await unzipWithPassword(P(uri), P(tmp), pass);
        let root = null;
        if ((await FS.getInfoAsync(tmp + 'index.json')).exists) root = tmp;
        else for (const d of await FS.readDirectoryAsync(tmp)) { if ((await FS.getInfoAsync(tmp + d + '/index.json')).exists) root = tmp + d + '/'; }
        if (!root) throw new Error('El archivo no parece un respaldo de Bóveda.');
        const bd = JSON.parse(await FS.readAsStringAsync(root + 'index.json'));
        const have = new Set([...db.items, ...db.trash].map((i) => i.id)); const add = [];
        for (const i of bd.items || []) { if (have.has(i.id)) continue; await FS.copyAsync({ from: root + 'files/' + i.file, to: p.files + i.file }); add.push(i); }
        commit({ ...db, items: [...add, ...db.items] });
        Alert.alert('Respaldo restaurado', `${add.length} archivos recuperados.`);
      } catch (e) { Alert.alert('No se pudo restaurar', 'Revisa la contraseña y el archivo. ' + String((e && e.message) || '')); }
      finally { FS.deleteAsync(tmp, { idempotent: true }).catch(() => {}); }
    });
  };
  return (
    <ScrollView style={{ flex: 1 }}>
      <View style={s.card}><Text style={s.h3}>Crear respaldo</Text><Text style={s.sub}>Un solo archivo .zip con todos tus archivos, protegido con contraseña. Guárdalo en Drive, en la memoria o en otra carpeta.</Text>
        <Btn main label="Crear respaldo" disabled={!db.items.length} onPress={() => setPw('make')} />
        <Text style={s.sub}>{S.lastBackup ? `Último respaldo: ${fmt(new Date(S.lastBackup).toISOString())}` : 'Aún no hay respaldos.'}</Text></View>
      <View style={s.card}><Text style={s.h3}>Restaurar respaldo</Text><Text style={s.sub}>Elige un .zip de respaldo y escribe su contraseña. Los archivos que ya tienes no se duplican.</Text><Btn label="Elegir archivo de respaldo" onPress={pick} /></View>
      {pw === 'make' && <PassModal title="Contraseña del respaldo" onOk={make} onCancel={() => setPw(null)} />}
      {pw === 'restore' && <PassModal title="Contraseña del respaldo" onOk={restore} onCancel={() => setPw(null)} />}
    </ScrollView>
  );
}

/* ---------- Ajustes ---------- */
function Settings({ S, saveS, busy }) {
  const [flow, setFlow] = useState(null);
  const Row = ({ k, t, d, onChange }) => (
    <View style={s.row}><View style={{ flex: 1, paddingRight: 10 }}><Text style={s.itemT}>{t}</Text><Text style={s.sub}>{d}</Text></View>
      <Switch value={!!S[k]} onValueChange={onChange || ((v) => saveS({ ...S, [k]: v }))} trackColor={{ true: C.acc, false: C.line }} thumbColor="#fff" /></View>
  );
  const fp = (v) => {
    if (!v) return saveS({ ...S, fp: false });
    busy(async () => {
      if (!(await LocalAuth.hasHardwareAsync()) || !(await LocalAuth.isEnrolledAsync())) return Alert.alert('Sin huella disponible', 'Primero registra una huella en los ajustes de tu celular.');
      const r = await LocalAuth.authenticateAsync({ promptMessage: 'Vincular huella' });
      if (r.success) saveS({ ...S, fp: true });
    });
  };
  return (
    <ScrollView style={{ flex: 1 }}>
      <View style={s.card}>
        <Row k="fp" t="Entrar con huella" d="Usa la huella registrada en tu celular. El PIN siempre sirve como respaldo." onChange={fp} />
        <Row k="autolock" t="Bloqueo automático" d="Se cierra al salir de la app o apagar la pantalla." />
        <Row k="noshot" t="Ocultar en recientes y bloquear capturas" d="Nadie ve tus archivos al cambiar de app." />
        <Row k="autobk" t="Recordatorio de respaldo" d="Te avisa si llevas una semana sin respaldar." />
        <Row k="decoy" t="PIN falso" d="Abre una bóveda distinta (vacía al inicio) si te obligan a abrirla." onChange={(v) => (v ? setFlow('decoy') : saveS({ ...S, decoy: false }))} />
      </View>
      <Btn label="Cambiar PIN" onPress={() => setFlow('cur')} />
      <Text style={s.sub}>Los archivos se guardan en el almacenamiento privado de la app, al que otras apps no pueden entrar.</Text>
      {flow && <Modal animationType="slide" onRequestClose={() => setFlow(null)}><View style={s.root}>
        {flow === 'cur' && <PinPad title="PIN actual" sub="Escribe tu PIN actual" onCancel={() => setFlow(null)} onPin={async (x) => { if (await checkPin('pin', x)) setFlow('new'); else Alert.alert('PIN incorrecto'); }} />}
        {flow === 'new' && <PinSetup title="Nuevo PIN" onCancel={() => setFlow(null)} onDone={async (x) => { await setPin('pin', x); setFlow(null); Alert.alert('Listo', 'Tu PIN fue cambiado.'); }} />}
        {flow === 'decoy' && <PinSetup title="PIN falso" onCancel={() => setFlow(null)} onDone={async (x) => { if (await checkPin('pin', x)) { Alert.alert('Elige otro', 'El PIN falso debe ser distinto al real.'); setFlow(null); return; } await setPin('dpin', x); saveS({ ...S, decoy: true }); setFlow(null); }} />}
      </View></Modal>}
    </ScrollView>
  );
}

/* ---------- Pantalla principal ---------- */
function Home({ mode, S, saveS, busy, lock }) {
  const [db, setDb] = useState(null); const [tab, setTab] = useState('vault'); const p = paths(mode);
  useEffect(() => { readDb(mode).then(setDb); }, []);
  const commit = (n) => { setDb(n); writeDb(mode, n).catch(() => {}); };
  if (!db) return <View style={s.root}><ActivityIndicator color={C.acc} /></View>;
  const tabs = [['vault', '🗄️', 'Bóveda'], ['intr', '📷', 'Intrusos'], ['backup', '☁️', 'Respaldo'], ['set', '⚙️', 'Ajustes']];
  return (
    <View style={s.root}>
      <View style={s.head}><Text style={s.h2}>{tabs.find((t) => t[0] === tab)[2]}</Text><Btn label="Bloquear" style={s.small} onPress={lock} /></View>
      <View style={{ flex: 1 }}>
        {tab === 'vault' && <Vault db={db} commit={commit} p={p} busy={busy} S={S} />}
        {tab === 'intr' && <Intruders db={db} commit={commit} p={p} />}
        {tab === 'backup' && <Backup db={db} commit={commit} p={p} busy={busy} S={S} saveS={saveS} />}
        {tab === 'set' && <Settings S={S} saveS={saveS} busy={busy} />}
      </View>
      <View style={s.nav}>{tabs.map(([k, ic, t]) => <TouchableOpacity key={k} style={{ flex: 1, alignItems: 'center', padding: 8 }} onPress={() => setTab(k)}><Text style={{ fontSize: 20 }}>{ic}</Text><Text style={{ color: tab === k ? C.acc : C.mute, fontSize: 12 }}>{t}</Text></TouchableOpacity>)}</View>
    </View>
  );
}

/* ---------- App ---------- */
export default function App() {
  const [S, setS] = useState(null); const [hasPin, setHasPin] = useState(null); const [mode, setMode] = useState(null); const [lk, setLk] = useState({ fails: 0, until: 0 });
  const busyRef = useRef(false);
  const busy = async (fn) => { busyRef.current = true; try { return await fn(); } finally { setTimeout(() => { busyRef.current = false; }, 1500); } };
  const saveS = (n) => { setS(n); sset('settings', n); };
  useEffect(() => { (async () => { setS({ ...DEF, ...((await sget('settings')) || {}) }); setLk((await sget('lk')) || { fails: 0, until: 0 }); setHasPin(!!(await sget('pin'))); })(); }, []);
  useEffect(() => { const sub = AppState.addEventListener('change', (st) => { if (st !== 'active' && S && S.autolock && !busyRef.current) setMode(null); }); return () => sub.remove(); }, [S && S.autolock]);
  useEffect(() => { if (S) (S.noshot ? ScreenCapture.preventScreenCaptureAsync() : ScreenCapture.allowScreenCaptureAsync()).catch(() => {}); }, [S && S.noshot]);
  let body;
  if (!S || hasPin === null) body = <View style={s.root}><ActivityIndicator color={C.acc} /></View>;
  else if (!hasPin) body = <View style={s.root}><PinSetup title="Crea tu PIN" onDone={async (x) => { await setPin('pin', x); setHasPin(true); }} /></View>;
  else if (!mode) body = <Lock S={S} lk={lk} setLk={setLk} onOpen={setMode} busy={busy} />;
  else body = <Home key={mode} mode={mode} S={S} saveS={saveS} busy={busy} lock={() => setMode(null)} />;
  return <View style={{ flex: 1, backgroundColor: C.bg }}><StatusBar style="light" />{body}</View>;
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: (RNStatusBar.currentHeight || 28) + 6, paddingHorizontal: 16, paddingBottom: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  dial: { fontSize: 44, marginBottom: 8 }, h1: { color: C.ink, fontSize: 28, fontWeight: '700', letterSpacing: 1 }, h2: { color: C.ink, fontSize: 22, fontWeight: '700' }, h3: { color: C.ink, fontSize: 17, fontWeight: '700', marginBottom: 6 },
  sub: { color: C.mute, fontSize: 13, marginVertical: 6, textAlign: 'center' },
  dots: { flexDirection: 'row', gap: 14, marginVertical: 18 }, dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: C.acc },
  pad: { width: 252, flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, key: { width: 72, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' }, keyT: { color: C.ink, fontSize: 24 },
  veil: { flex: 1, backgroundColor: 'rgba(0,0,0,.6)', justifyContent: 'flex-end' }, sheet: { backgroundColor: C.card, padding: 18, borderTopLeftRadius: 18, borderTopRightRadius: 18 },
  input: { backgroundColor: C.bg, color: C.ink, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 10, marginBottom: 10, fontSize: 15 },
  btn: { borderWidth: 1, borderColor: C.line, backgroundColor: C.bg, borderRadius: 12, padding: 13, alignItems: 'center', marginTop: 8 }, btnMain: { backgroundColor: C.acc, borderColor: C.acc }, btnT: { color: C.ink, fontSize: 15 },
  small: { paddingVertical: 8, paddingHorizontal: 12, marginTop: 0, marginLeft: 8 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  tool: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, justifyContent: 'flex-end' },
  chip: { borderWidth: 1, borderColor: C.line, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 14, marginRight: 8, backgroundColor: C.card }, chipOn: { backgroundColor: C.acc, borderColor: C.acc },
  item: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderLeftWidth: 3, borderLeftColor: C.acc, borderRadius: 12, padding: 10, marginBottom: 8 }, itemT: { color: C.ink, fontSize: 15 },
  empty: { color: C.mute, textAlign: 'center', padding: 30, fontSize: 15 }, warn: { color: C.bad, textAlign: 'center', marginVertical: 4 },
  fab: { position: 'absolute', right: 6, bottom: 8, backgroundColor: C.acc, borderRadius: 22, paddingVertical: 10, paddingHorizontal: 16 },
  bulk: { flexDirection: 'row', paddingTop: 6 }, nav: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.card, marginHorizontal: -16, marginBottom: -12 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 14, marginBottom: 12 }, row: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  tick: { position: 'absolute', top: 6, right: 6, width: 22, height: 22, borderRadius: 11, backgroundColor: C.acc, alignItems: 'center', justifyContent: 'center' }, ph: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 4 },
});
