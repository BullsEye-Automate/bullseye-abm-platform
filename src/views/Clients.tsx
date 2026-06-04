import { useEffect, useState, useRef, type ChangeEvent } from "react";
import { card, Btn, Badge, Modal, Field, INP, ChannelConfig } from "../components/ui";
import { C } from "../lib/utils";
import { clientsRepo, campaignsRepo, sourcesRepo } from "../lib/db";
import { setLemlistKey } from "../lib/api";
import { readBase64, readText } from "../lib/utils";
import type { Client, BullseyeCampaign, BullseyeSource, Channel } from "../types/db";
import { supabase } from "../lib/supabase";

interface Props {
  onSelectCampaign: (campaignId: string) => void;
}

interface ClientFormData {
  name: string;
  industry: string;
  website: string;
  contact: string;
}
const blankClient: ClientFormData = { name: "", industry: "", website: "", contact: "" };

interface CampaignFormData {
  name: string;
  goal: string;
  industry: string;
  role: string;
  channels: Channel[];
  msgs_per_channel: Record<Channel, number>;
}
const blankCampaign: CampaignFormData = {
  name: "", goal: "", industry: "", role: "",
  channels: ["linkedin", "email"],
  msgs_per_channel: { linkedin: 1, email: 1, whatsapp: 1 },
};

export function ClientsView({ onSelectCampaign }: Props) {
  const [clients, setClients] = useState<Client[]>([]);
  const [campaigns, setCampaigns] = useState<BullseyeCampaign[]>([]);
  const [showNewClient, setShowNewClient] = useState(false);
  const [showNewCampForClient, setShowNewCampForClient] = useState<string | null>(null);
  const [showLemlistKeyFor, setShowLemlistKeyFor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [cf, setCf] = useState<ClientFormData>(blankClient);
  const [pf, setPf] = useState<CampaignFormData>(blankCampaign);

  useEffect(() => {
    (async () => {
      const [cls, camps] = await Promise.all([clientsRepo.list(), campaignsRepo.listAll()]);
      setClients(cls);
      setCampaigns(camps);
    })();
  }, []);

  const reload = async () => {
    const [cls, camps] = await Promise.all([clientsRepo.list(), campaignsRepo.listAll()]);
    setClients(cls);
    setCampaigns(camps);
  };

  const handleCreateClient = async () => {
    if (!cf.name.trim()) return;
    const created = await clientsRepo.create(cf);
    setCf(blankClient);
    setShowNewClient(false);
    setExpanded(created.id);
    reload();
  };

  const handleDeleteClient = async (id: string) => {
    if (!window.confirm("¿Eliminar cliente y todas sus campañas?")) return;
    await clientsRepo.remove(id);
    reload();
  };

  const handleCreateCampaign = async () => {
    if (!pf.name.trim() || !showNewCampForClient) return;
    const created = await campaignsRepo.create({
      client_id: showNewCampForClient,
      name: pf.name,
      goal: pf.goal,
      industry: pf.industry,
      role: pf.role,
      channels: pf.channels,
      msgs_per_channel: pf.msgs_per_channel,
      status: "draft",
    });
    setPf(blankCampaign);
    setShowNewCampForClient(null);
    onSelectCampaign(created.id);
  };

  const campClient = clients.find(c => c.id === showNewCampForClient);
  const lemlistClient = clients.find(c => c.id === showLemlistKeyFor);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "28px" }}>
        <div>
          <div style={{ fontSize: "22px", fontWeight: 700, color: C.text }}>Clientes</div>
          <div style={{ fontSize: "14px", color: C.textMuted }}>
            {clients.length} cuenta{clients.length !== 1 ? "s" : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: C.textFaint, fontSize: "13px", pointerEvents: "none" }}>🔍</span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar cliente..."
              style={{ ...INP, paddingLeft: "30px", width: "200px", height: "34px" }}
            />
          </div>
          <Btn v="primary" onClick={() => setShowNewClient(true)}>+ Nuevo cliente</Btn>
        </div>
      </div>

      {clients.length === 0 && (
        <div style={card({ textAlign: "center", padding: "56px 32px" })}>
          <div style={{ fontSize: "15px", fontWeight: 600, color: C.textMd, marginBottom: "8px" }}>
            Sin clientes todavía
          </div>
          <Btn v="primary" onClick={() => setShowNewClient(true)}>+ Crear primer cliente</Btn>
        </div>
      )}

      {clients.filter(cl => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        return cl.name.toLowerCase().includes(q) || (cl.industry || "").toLowerCase().includes(q);
      }).map(cl => {
        const clC = campaigns.filter(c => c.client_id === cl.id);
        const isExp = expanded === cl.id;
        const ini = cl.name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
        const hasLemlist = !!cl.bullseye_lemlist_api_key_encrypted;
        return (
          <div key={cl.id} style={card({ padding: 0, overflow: "hidden", marginBottom: "12px" })}>
            <div
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", cursor: "pointer" }}
              onClick={() => setExpanded(isExp ? null : cl.id)}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "14px", flex: 1, minWidth: 0 }}>
                <div style={{
                  width: "40px", height: "40px", borderRadius: "10px", background: C.accentBg,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "14px", fontWeight: 700, color: C.accent, flexShrink: 0,
                }}>{ini}</div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "14px", color: C.text }}>{cl.name}</div>
                  <div style={{ fontSize: "12px", color: C.textMuted }}>
                    {cl.industry || "Sin industria"} · {clC.length} campaña{clC.length !== 1 ? "s" : ""}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
                {hasLemlist && <Badge color="green">Lemlist ✓</Badge>}
                {clC.some(c => c.status === "active") && <Badge color="blue">Activo</Badge>}
                <Btn v="ghost" onClick={e => { e.stopPropagation(); setShowLemlistKeyFor(cl.id); }}>
                  🔑 Lemlist
                </Btn>
                <Btn v="ghost" onClick={e => { e.stopPropagation(); handleDeleteClient(cl.id); }}>×</Btn>
                <span style={{ color: C.textFaint, fontSize: "12px" }}>{isExp ? "▾" : "▸"}</span>
              </div>
            </div>
            {isExp && (
              <ClientPanel
                client={cl}
                campaigns={clC}
                onSelectCampaign={onSelectCampaign}
                onAddCampaign={() => setShowNewCampForClient(cl.id)}
              />
            )}
          </div>
        );
      })}

      {/* Modal: Nuevo cliente */}
      {showNewClient && (
        <Modal title="Nuevo cliente" onClose={() => setShowNewClient(false)}>
          <Field label="Nombre *" value={cf.name} onChange={v => setCf(p => ({ ...p, name: v }))} placeholder="Ej: Salesforce..." />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <Field label="Industria" value={cf.industry} onChange={v => setCf(p => ({ ...p, industry: v }))} />
            <Field label="Website" value={cf.website} onChange={v => setCf(p => ({ ...p, website: v }))} />
          </div>
          <Field label="Contacto principal" value={cf.contact} onChange={v => setCf(p => ({ ...p, contact: v }))} />
          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <Btn v="ghost" onClick={() => setShowNewClient(false)}>Cancelar</Btn>
            <Btn v="primary" onClick={handleCreateClient}>Crear cliente</Btn>
          </div>
        </Modal>
      )}

      {/* Modal: Nueva campaña */}
      {showNewCampForClient && campClient && (
        <Modal title={"Nueva campaña — " + campClient.name} onClose={() => setShowNewCampForClient(null)} width="600px">
          <Field label="Nombre *" value={pf.name} onChange={v => setPf(p => ({ ...p, name: v }))} placeholder="Ej: Q2 2025 - VP Engineering" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <Field label="Objetivo" value={pf.goal} onChange={v => setPf(p => ({ ...p, goal: v }))} />
            <Field label="Industria objetivo" value={pf.industry} onChange={v => setPf(p => ({ ...p, industry: v }))} />
          </div>
          <Field label="Cargo objetivo" value={pf.role} onChange={v => setPf(p => ({ ...p, role: v }))} />
          <div style={{ marginBottom: "16px" }}>
            <label style={{ fontSize: "12px", fontWeight: 600, color: C.textMd, marginBottom: "6px", display: "block" }}>Canales</label>
            <ChannelConfig
              channels={pf.channels}
              msgsPerChannel={pf.msgs_per_channel}
              onChangeChannels={chs => setPf(p => ({ ...p, channels: chs }))}
              onChangeMsgs={m => setPf(p => ({ ...p, msgs_per_channel: m }))}
            />
          </div>
          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <Btn v="ghost" onClick={() => setShowNewCampForClient(null)}>Cancelar</Btn>
            <Btn v="primary" onClick={handleCreateCampaign}>Crear campaña</Btn>
          </div>
        </Modal>
      )}

      {/* Modal: Lemlist API key */}
      {showLemlistKeyFor && lemlistClient && (
        <LemlistKeyModal
          client={lemlistClient}
          onClose={() => setShowLemlistKeyFor(null)}
          onSaved={() => { setShowLemlistKeyFor(null); reload(); }}
        />
      )}
    </div>
  );
}

// ─── ClientPanel: campañas + fuentes (cuando expandes un cliente) ──────────────
function ClientPanel({
  client, campaigns, onSelectCampaign, onAddCampaign,
}: {
  client: Client;
  campaigns: BullseyeCampaign[];
  onSelectCampaign: (id: string) => void;
  onAddCampaign: () => void;
}) {
  const [sources, setSources] = useState<BullseyeSource[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [srcErr, setSrcErr] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const docRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    sourcesRepo.listByClient(client.id).then(setSources);
  }, [client.id]);

  const refresh = () => sourcesRepo.listByClient(client.id).then(setSources);

  const addUrl = async () => {
    const raw = newUrl.trim();
    if (!raw) return;
    setSrcErr(null);
    const lines = raw.split(/\n/).map(l => l.trim()).filter(Boolean);
    try {
      for (const line of lines) {
        const url = line.startsWith("http") ? line : "https://" + line;
        await sourcesRepo.create({
          client_id: client.id,
          type: "url",
          name: url.replace(/^https?:\/\//, "").split("/")[0],
          url,
        });
      }
      setNewUrl("");
      refresh();
    } catch (err: unknown) {
      setSrcErr("Error al guardar URL: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleDocSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setPendingFiles(prev => {
      const existingNames = new Set(prev.map(f => f.name));
      return [...prev, ...files.filter(f => !existingNames.has(f.name))];
    });
    if (e.target) e.target.value = "";
  };

  const removePendingFile = (name: string) => {
    setPendingFiles(prev => prev.filter(f => f.name !== name));
  };

  const uploadPendingFiles = async () => {
    if (!pendingFiles.length) return;
    setSrcErr(null);
    setUploading(true);
    const errors: string[] = [];
    for (const f of pendingFiles) {
      try {
        if (f.name.toLowerCase().endsWith(".pdf")) {
          const b64 = await readBase64(f);
          await sourcesRepo.create({
            client_id: client.id, type: "pdf", name: f.name, size: f.size,
            content: b64,
          });
        } else {
          const content = (await readText(f)).slice(0, 8000);
          await sourcesRepo.create({
            client_id: client.id, type: "text", name: f.name, size: f.size, content,
          });
        }
      } catch (err: unknown) {
        errors.push(`${f.name}: ` + (err instanceof Error ? err.message : String(err)));
      }
    }
    setPendingFiles([]);
    setUploading(false);
    if (errors.length) setSrcErr("Errores al subir:\n" + errors.join("\n"));
    refresh();
  };

  const deleteSrc = async (id: string) => {
    try {
      await sourcesRepo.remove(id);
      refresh();
    } catch (err: unknown) {
      setSrcErr("Error al eliminar: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  const sH = {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "12px 20px", background: C.pageBg, borderBottom: "1px solid " + C.border,
  };

  return (
    <div style={{ borderTop: "1px solid " + C.border }}>
      <div style={sH}>
        <span style={{ fontSize: "11px", fontWeight: 700, color: C.accent, letterSpacing: "0.05em", textTransform: "uppercase" }}>
          Campañas ({campaigns.length})
        </span>
        <Btn v="sm" onClick={onAddCampaign}>+ Nueva campaña</Btn>
      </div>
      <div style={{ padding: "14px 20px", borderBottom: "2px solid " + C.border }}>
        {campaigns.length === 0 ? (
          <div style={{ color: C.textFaint, fontSize: "13px", textAlign: "center", padding: "16px", background: C.pageBg, borderRadius: "8px" }}>
            Sin campañas
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead><tr>{["Campaña", "Estado", ""].map(h => <th key={h} style={{ textAlign: "left", padding: "8px 0", fontSize: "11px", color: C.textMuted, textTransform: "uppercase" }}>{h}</th>)}</tr></thead>
            <tbody>
              {campaigns.map(c => (
                <tr key={c.id}>
                  <td style={{ padding: "8px 0" }}>{c.name}</td>
                  <td style={{ padding: "8px 0" }}><Badge color={c.status === "active" ? "green" : c.status === "paused" ? "blue" : "amber"}>{c.status}</Badge></td>
                  <td style={{ padding: "8px 0", textAlign: "right" }}><Btn v="sm" onClick={() => onSelectCampaign(c.id)}>Abrir</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div style={sH}>
        <span style={{ fontSize: "11px", fontWeight: 700, color: C.purple, letterSpacing: "0.05em", textTransform: "uppercase" }}>
          Fuentes ({sources.length})
        </span>
      </div>
      <div style={{ padding: "16px 20px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
          <div style={{ background: C.pageBg, border: "1px solid " + C.border, borderRadius: "8px", padding: "12px" }}>
            <div style={{ fontSize: "12px", fontWeight: 600, color: C.textMd, marginBottom: "8px" }}>
              URLs <span style={{ fontWeight: 400, color: C.textFaint }}>(una por línea)</span>
            </div>
            <div style={{ display: "flex", gap: "6px", alignItems: "flex-start" }}>
              <textarea
                style={{ ...INP, fontSize: "12px", padding: "7px 10px", height: "64px", resize: "none" }}
                value={newUrl}
                onChange={e => setNewUrl(e.target.value)}
                placeholder={"https://empresa.com\nhttps://empresa.com/blog"}
              />
              <Btn v="purple" onClick={addUrl} style={{ padding: "7px 10px", fontSize: "12px", flexShrink: 0 }}>+</Btn>
            </div>
          </div>
          <div style={{ background: C.pageBg, border: "1px solid " + C.border, borderRadius: "8px", padding: "12px" }}>
            <div style={{ fontSize: "12px", fontWeight: 600, color: C.textMd, marginBottom: "8px" }}>
              Documentos <span style={{ fontWeight: 400, color: C.textFaint }}>.pdf · .txt · .md</span>
            </div>
            <div onClick={() => !uploading && docRef.current?.click()} style={{
              border: "2px dashed " + C.borderMd, borderRadius: "6px", padding: "14px 8px",
              textAlign: "center", cursor: uploading ? "default" : "pointer", fontSize: "12px", color: C.textMuted,
            }}>
              {uploading ? "Subiendo..." : "Haz clic o arrastra archivos (puedes seleccionar varios)"}
            </div>
            <input ref={docRef} type="file" accept=".pdf,.txt,.md" multiple style={{ display: "none" }} onChange={handleDocSelect} />

            {pendingFiles.length > 0 && (
              <div style={{ marginTop: "10px" }}>
                <div style={{ fontSize: "11px", fontWeight: 700, color: C.textMuted, textTransform: "uppercase", marginBottom: "6px" }}>
                  {pendingFiles.length} archivo{pendingFiles.length !== 1 ? "s" : ""} listo{pendingFiles.length !== 1 ? "s" : ""} para subir
                </div>
                {pendingFiles.map(f => (
                  <div key={f.name} style={{
                    display: "flex", alignItems: "center", gap: "8px",
                    padding: "5px 8px", background: C.accentBg, borderRadius: "5px", marginBottom: "4px",
                  }}>
                    <span style={{ fontSize: "11px", color: "#C0392B", fontWeight: 700 }}>PDF</span>
                    <span style={{ flex: 1, fontSize: "12px", color: C.textMd, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                    <span style={{ fontSize: "11px", color: C.textFaint }}>{(f.size / 1024).toFixed(0)} KB</span>
                    <button
                      onClick={() => removePendingFile(f.name)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: C.textFaint, fontSize: "14px", lineHeight: 1, padding: "0 2px" }}
                    >×</button>
                  </div>
                ))}
                <Btn
                  v="primary"
                  onClick={uploadPendingFiles}
                  disabled={uploading}
                  style={{ marginTop: "8px", width: "100%", justifyContent: "center" }}
                >
                  {uploading ? "Subiendo..." : `Subir ${pendingFiles.length} archivo${pendingFiles.length !== 1 ? "s" : ""}`}
                </Btn>
              </div>
            )}
          </div>
        </div>
        {srcErr && (
          <div style={{ padding: "10px 12px", background: "#FFF5F5", border: "1px solid #FACCCC", borderRadius: "8px", fontSize: "12px", color: "#C0392B", marginBottom: "10px", whiteSpace: "pre-wrap" }}>
            {srcErr}
            <button onClick={() => setSrcErr(null)} style={{ float: "right", background: "none", border: "none", cursor: "pointer", color: "#C0392B", fontSize: "14px" }}>×</button>
          </div>
        )}
        {sources.map(s => (
          <div key={s.id} style={{
            display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px",
            background: C.pageBg, border: "1px solid " + C.border, borderRadius: "6px", marginBottom: "4px",
          }}>
            <Badge color={s.type === "url" ? "blue" : s.type === "pdf" ? "red" : "amber"}>{s.type}</Badge>
            <div style={{ flex: 1, fontSize: "12px", color: C.textMd, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.type === "url" ? s.url : s.name}
            </div>
            <Btn v="danger" onClick={() => deleteSrc(s.id)}>×</Btn>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── LemlistKeyModal: setear/borrar API key Lemlist por cliente ─────────────────
function LemlistKeyModal({
  client, onClose, onSaved,
}: {
  client: Client;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasKey = !!client.bullseye_lemlist_api_key_encrypted;

  const handleSave = async () => {
    if (!key.trim()) return;
    setSaving(true); setErr(null);
    try {
      await setLemlistKey(client.id, key.trim());
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setSaving(false);
  };

  const handleRemove = async () => {
    if (!window.confirm("¿Eliminar la API key de Lemlist de este cliente?")) return;
    setSaving(true); setErr(null);
    try {
      await setLemlistKey(client.id, null);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setSaving(false);
  };

  return (
    <Modal title={"🔑 Lemlist API Key — " + client.name} onClose={onClose} width="500px">
      <div style={{ background: C.infoBg, border: "1px solid " + C.info + "44", borderRadius: "8px", padding: "10px 14px", fontSize: "12px", color: C.textMd, marginBottom: "16px" }}>
        La key se guarda <strong>encriptada</strong> en la base de datos. Solo el backend puede desencriptarla para llamar a Lemlist.
      </div>
      {hasKey ? (
        <div style={{ marginBottom: "16px", padding: "12px", background: C.successBg, borderRadius: "8px", fontSize: "13px", color: C.success }}>
          ✓ Este cliente ya tiene una API key de Lemlist configurada.
        </div>
      ) : null}
      <Field
        label={hasKey ? "Reemplazar con nueva key" : "Pega tu API key de Lemlist"}
        value={key}
        onChange={setKey}
        type="password"
        placeholder="lemlist_xxxxxxxxxxxx"
      />
      {err && (
        <div style={{ padding: "10px", background: "#FFF5F5", border: "1px solid #FACCCC", borderRadius: "6px", fontSize: "12px", color: "#C0392B", marginBottom: "12px" }}>
          {err}
        </div>
      )}
      <div style={{ display: "flex", gap: "10px", justifyContent: "space-between" }}>
        {hasKey ? (
          <Btn v="danger" onClick={handleRemove} disabled={saving}>Eliminar key</Btn>
        ) : <span />}
        <div style={{ display: "flex", gap: "10px" }}>
          <Btn v="ghost" onClick={onClose}>Cancelar</Btn>
          <Btn v="primary" onClick={handleSave} disabled={saving || !key.trim()}>
            {saving ? "Guardando..." : "Guardar"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

void supabase; // keep import for future Storage use
