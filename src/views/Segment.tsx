import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { card, Btn, Badge, Modal, INP, TH, TD } from "../components/ui";
import { C, parseCSV, applyColumnMap, FIELD_LABELS, readText } from "../lib/utils";
import {
  segmentsRepo, contactsRepo, messagesRepo, personasRepo, directivesRepo, sourcesRepo,
} from "../lib/db";
import { supabase } from "../lib/supabase";
import { GenService, generatePersona, isErrorMsg, simulateMessages } from "../lib/genService";
import type { SimulationResult } from "../lib/genService";
import { callLemlist } from "../lib/api";
import type {
  BullseyeCampaign, BullseyeSegment, Client,
  BullseyeContact, BullseyeMessage, BullseyePersona, BullseyeSource,
} from "../types/db";

interface Props {
  segmentId: string;
  campaign: BullseyeCampaign;
  client: Client | null;
  onBack: () => void;
}

type Tab = "contacts" | "messages" | "sources" | "persona" | "lemlist" | "simulator";

export function SegmentDetail({ segmentId, campaign, client, onBack }: Props) {
  const [segment, setSegment] = useState<BullseyeSegment | null>(null);
  const [contacts, setContacts] = useState<BullseyeContact[]>([]);
  const [messages, setMessages] = useState<BullseyeMessage[]>([]);
  const [persona, setPersona] = useState<BullseyePersona | null>(null);
  const [directives, setDirectives] = useState("");
  const [sources, setSources] = useState<BullseyeSource[]>([]);
  const [tab, setTab] = useState<Tab>("contacts");
  const [csvRaw, setCsvRaw] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [showDir, setShowDir] = useState(false);
  const [genPersona, setGenPersona] = useState(false);
  const [simResult, setSimResult] = useState<SimulationResult | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const dirSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const srcDocRef = useRef<HTMLInputElement>(null);
  const [newSrcUrl, setNewSrcUrl] = useState("");
  const [srcUploading, setSrcUploading] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  const [genJobs, setGenJobs] = useState(GenService.getJobs());
  useEffect(() => {
    const unsub = GenService.subscribe(setGenJobs);
    return () => { unsub(); };
  }, []);
  const currentJob = genJobs.get(segmentId);
  const isGenerating = !!currentJob;

  // Cargar todo
  const loadAll = async () => {
    const [seg, cts, msgs, p, dir, srcs] = await Promise.all([
      segmentsRepo.get(segmentId),
      contactsRepo.listBySegment(segmentId),
      messagesRepo.listBySegment(segmentId),
      personasRepo.getBySegment(segmentId),
      directivesRepo.getBySegment(segmentId),
      client ? sourcesRepo.listByClient(client.id) : Promise.resolve([]),
    ]);
    setSegment(seg);
    setContacts(cts);
    setMessages(msgs);
    setPersona(p);
    setDirectives(dir);
    setSources(srcs);
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentId]);

  // Auto-refresh durante generación
  useEffect(() => {
    if (!isGenerating) return;
    const iv = setInterval(async () => {
      const m = await messagesRepo.listBySegment(segmentId);
      setMessages(m);
    }, 1500);
    return () => clearInterval(iv);
  }, [isGenerating, segmentId]);

  // Refresh al terminar generación
  useEffect(() => {
    if (!isGenerating) {
      messagesRepo.listBySegment(segmentId).then(setMessages);
      segmentsRepo.get(segmentId).then(setSegment);
    }
  }, [isGenerating, segmentId]);

  const saveDirectives = (text: string) => {
    setDirectives(text);
    if (dirSaveTimer.current) clearTimeout(dirSaveTimer.current);
    dirSaveTimer.current = setTimeout(() => directivesRepo.set(segmentId, text), 800);
  };

  // ─── CSV import ──────────────────────────────────────────────────────────────
  const handleCSV = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await readText(f);
    setCsvRaw(parseCSV(text));
    if (e.target) e.target.value = "";
  };

  const handleCSVConfirm = async (parsed: Record<string, string>[]) => {
    if (parsed.length) {
      await contactsRepo.bulkInsert(segmentId, parsed);
      await segmentsRepo.refreshCounts(segmentId);
      loadAll();
    }
    setCsvRaw(null);
  };

  // ─── Generación ──────────────────────────────────────────────────────────────
  const startGen = async (mode: "all" | "pending" | "errors") => {
    if (isGenerating || !segment) return;
    let toProcess: BullseyeContact[] = [];
    if (mode === "all") {
      toProcess = contacts;
    } else if (mode === "pending") {
      const existing = new Set(messages.map(m => m.contact_id));
      toProcess = contacts.filter(c => !existing.has(c.id));
    } else {
      const errIds = new Set(messages.filter(isErrorMsg).map(m => m.contact_id));
      toProcess = contacts.filter(c => errIds.has(c.id));
    }
    if (!toProcess.length) {
      setTab("messages");
      return;
    }
    GenService.start(segmentId, {
      segment, campaign, client, sources, directives, toProcess,
      onDone: () => loadAll(),
    });
    setTab("messages");
  };

  const approveAll = async () => {
    await messagesRepo.setAllApproved(segmentId, true);
    await segmentsRepo.refreshCounts(segmentId);
    loadAll();
  };
  const disapproveAll = async () => {
    await messagesRepo.setAllApproved(segmentId, false);
    await segmentsRepo.refreshCounts(segmentId);
    loadAll();
  };
  const toggleApprove = async (msg: BullseyeMessage) => {
    await messagesRepo.update(msg.id, { approved: !msg.approved });
    await segmentsRepo.refreshCounts(segmentId);
    loadAll();
  };

  const handleGenPersona = async () => {
    if (!campaign) return;
    setGenPersona(true);
    try {
      const titles = contacts.map(c => c.title || "").filter(Boolean);
      const p = await generatePersona(campaign.role || "", campaign.industry || "", titles);
      const saved = await personasRepo.upsert({ segment_id: segmentId, ...p });
      setPersona(saved);
    } catch (e: unknown) {
      alert("Error: " + (e instanceof Error ? e.message : String(e)));
    }
    setGenPersona(false);
  };

  const handleSimulate = async () => {
    if (simLoading) return;
    setSimLoading(true);
    try {
      const result = await simulateMessages(messages, contacts, persona, campaign);
      setSimResult(result);
    } catch (e: unknown) {
      alert("Error en simulación: " + (e instanceof Error ? e.message : String(e)));
    }
    setSimLoading(false);
  };

  const handleApplySuggestions = async () => {
    if (!simResult || isGenerating || !segment) return;
    const suggestionBlock = "\n\nSUGERENCIAS DE SIMULACIÓN (aplicar obligatoriamente):\n" +
      simResult.insights.suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n");
    const newDirectives = (directives || "").trim() + suggestionBlock;
    saveDirectives(newDirectives);
    await directivesRepo.set(segmentId, newDirectives);
    GenService.start(segmentId, {
      segment, campaign, client, sources, directives: newDirectives, toProcess: contacts,
      onDone: () => loadAll(),
    });
    setTab("messages");
  };

  const addSrcUrl = async () => {
    if (!client || !newSrcUrl.trim()) return;
    const url = newSrcUrl.startsWith("http") ? newSrcUrl : "https://" + newSrcUrl;
    await sourcesRepo.create({
      client_id: client.id, type: "url",
      name: url.replace(/^https?:\/\//, "").split("/")[0], url,
    });
    setNewSrcUrl("");
    sourcesRepo.listByClient(client.id).then(setSources);
  };

  const handleSrcDocSelect = (e: ChangeEvent<HTMLInputElement>) => {
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
    if (!client || !pendingFiles.length) return;
    setSrcUploading(true);
    for (const f of pendingFiles) {
      try {
        if (f.name.toLowerCase().endsWith(".pdf")) {
          const path = `bullseye-pdfs/${client.id}/${Date.now()}-${f.name}`;
          const { error: upErr } = await supabase.storage.from("bullseye-sources").upload(path, f);
          if (upErr) { console.warn("Error subiendo PDF:", upErr); continue; }
          const { data: pub } = supabase.storage.from("bullseye-sources").getPublicUrl(path);
          await sourcesRepo.create({ client_id: client.id, type: "pdf", name: f.name, size: f.size, storage_path: pub.publicUrl });
        } else {
          const content = (await readText(f)).slice(0, 8000);
          await sourcesRepo.create({ client_id: client.id, type: "text", name: f.name, size: f.size, content });
        }
      } catch (err) { console.error("Error subiendo fuente:", err); }
    }
    setPendingFiles([]);
    setSrcUploading(false);
    sourcesRepo.listByClient(client.id).then(setSources);
  };

  const deleteSrc = async (id: string) => {
    await sourcesRepo.remove(id);
    if (client) sourcesRepo.listByClient(client.id).then(setSources);
  };

  if (!segment) return <div style={{ color: C.textMuted }}>Cargando segmento...</div>;

  const approved = messages.filter(m => m.approved).length;
  const pending = contacts.filter(c => !messages.find(m => m.contact_id === c.id)).length;
  const hasErrors = messages.some(isErrorMsg);
  const tabs: { k: Tab; l: string }[] = [
    { k: "contacts",  l: "Contactos" },
    { k: "messages",  l: "Mensajes" },
    { k: "sources",   l: "Fuentes" },
    { k: "persona",   l: "Buyer Persona" },
    { k: "simulator", l: "Simulador" },
    { k: "lemlist",   l: "Enviar a Lemlist" },
  ];

  return (
    <div style={card({ padding: 0, overflow: "hidden" })}>
      {csvRaw && <ColumnMapper rawData={csvRaw} onConfirm={handleCSVConfirm} onCancel={() => setCsvRaw(null)} />}

      <div style={{ padding: "14px 20px", background: C.pageBg, borderBottom: "1px solid " + C.border, display: "flex", alignItems: "center", gap: "12px" }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: C.accent, fontSize: "13px" }}>← Volver</button>
        <div style={{ flex: 1 }}>
          <span style={{ fontWeight: 600, fontSize: "14px", color: C.text }}>{segment.name}</span>
          {segment.criteria && <span style={{ fontSize: "12px", color: C.textMuted, marginLeft: "8px" }}>{segment.criteria}</span>}
        </div>
        <span style={{ fontSize: "12px", color: C.textMuted }}>{contacts.length} contactos</span>
        <span style={{ fontSize: "12px", color: C.success, fontWeight: 600 }}>{approved} aprobados</span>
        {isGenerating && currentJob && <Badge color="purple">⚙ {currentJob.current}/{currentJob.total}</Badge>}
      </div>

      <div style={{ padding: "20px 22px" }}>
        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid " + C.border, marginBottom: "20px" }}>
          {tabs.map(({ k, l }) => (
            <button key={k} onClick={() => setTab(k)} style={{
              background: "none", border: "none",
              borderBottom: "2.5px solid " + (tab === k ? C.accent : "transparent"),
              padding: "8px 16px", cursor: "pointer",
              color: tab === k ? C.accent : C.textMuted,
              fontSize: "13px", fontWeight: tab === k ? 600 : 400, marginBottom: "-1px",
            }}>{l}</button>
          ))}
        </div>

        {/* CONTACTS TAB */}
        {tab === "contacts" && (
          <div>
            <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap", alignItems: "center" }}>
              <Btn v="primary" onClick={() => fileRef.current?.click()}>
                {contacts.length > 0 ? "+ Subir CSV adicional" : "Subir CSV"}
              </Btn>
              <input ref={fileRef} type="file" accept=".csv,.txt" style={{ display: "none" }} onChange={handleCSV} />
              {contacts.length > 0 && (
                <span style={{ fontSize: "12px", color: C.textMuted }}>
                  {contacts.length} contactos / {pending} sin mensaje
                </span>
              )}
            </div>
            {contacts.length === 0 ? (
              <div style={card({ textAlign: "center", padding: "40px" })}>
                <div style={{ fontSize: "14px", color: C.textMuted }}>Sin contactos — sube un CSV</div>
              </div>
            ) : (
              <div style={card({ padding: 0, overflow: "hidden" })}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                  <thead><tr>{["Nombre", "Cargo", "Empresa", "Email", "Estado"].map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
                  <tbody>
                    {contacts.slice(0, 100).map(c => {
                      const hm = messages.find(m => m.contact_id === c.id);
                      return (
                        <tr key={c.id}>
                          <td style={TD}>{c.name || "-"}</td>
                          <td style={TD}><span style={{ color: C.textMuted }}>{c.title || "-"}</span></td>
                          <td style={TD}>{c.company || "-"}</td>
                          <td style={TD}><span style={{ color: C.textMuted }}>{c.email || "-"}</span></td>
                          <td style={TD}>{hm
                            ? (isErrorMsg(hm) ? <Badge color="red">Error</Badge> : hm.approved ? <Badge color="green">Aprobado</Badge> : <Badge color="amber">Pendiente</Badge>)
                            : <Badge color="gray">Sin mensaje</Badge>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {contacts.length > 100 && (
                  <div style={{ padding: "10px 14px", fontSize: "12px", color: C.textMuted, textAlign: "center", background: C.pageBg }}>
                    Mostrando 100 de {contacts.length} contactos
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* MESSAGES TAB */}
        {tab === "messages" && (
          <div>
            <div style={card({ marginBottom: "16px", background: C.pageBg })}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                  {!isGenerating && contacts.length === 0 && <Btn v="success" disabled>Generar mensajes</Btn>}
                  {!isGenerating && contacts.length > 0 && pending === contacts.length && (
                    <Btn v="success" onClick={() => startGen("all")}>Generar mensajes ({contacts.length})</Btn>
                  )}
                  {!isGenerating && contacts.length > 0 && pending > 0 && pending < contacts.length && (
                    <Btn v="success" onClick={() => startGen("pending")}>Generar pendientes ({pending})</Btn>
                  )}
                  {!isGenerating && messages.length > 0 && (
                    <Btn v="ghost" onClick={() => startGen("all")}>↻ Regenerar todos</Btn>
                  )}
                  {!isGenerating && hasErrors && <Btn v="warn" onClick={() => startGen("errors")}>↻ Rehacer errores</Btn>}
                  {isGenerating && currentJob && (
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <div style={{ width: "140px", height: "6px", background: C.border, borderRadius: "10px", overflow: "hidden" }}>
                        <div style={{ width: (currentJob.total ? currentJob.current / currentJob.total * 100 : 0) + "%", height: "100%", background: C.success }} />
                      </div>
                      <span style={{ fontSize: "12px", color: C.textMuted }}>{currentJob.current}/{currentJob.total}</span>
                      <button onClick={() => GenService.cancel(segmentId)} style={{
                        background: "none", border: "none", color: "#C0392B", fontSize: "11px",
                        cursor: "pointer", textDecoration: "underline",
                      }}>Cancelar</button>
                    </div>
                  )}
                </div>
                <Btn v="ghost" onClick={() => setShowDir(v => !v)}>
                  {showDir ? "Ocultar" : directives ? "Directrices activas" : "Agregar directrices"}
                </Btn>
              </div>
              {showDir && (
                <div style={{ marginTop: "14px" }}>
                  <textarea
                    value={directives}
                    onChange={e => saveDirectives(e.target.value)}
                    placeholder="Ej: Usa tono formal, no menciones precios..."
                    style={{ ...INP, height: "80px", resize: "vertical", fontSize: "12px" }}
                  />
                </div>
              )}
              {directives && !showDir && (
                <div style={{ fontSize: "12px", color: C.textMd, marginTop: "10px", padding: "8px 10px", background: C.warnBg, borderRadius: "6px", borderLeft: "3px solid " + C.warn }}>
                  Directriz activa: {directives.slice(0, 100)}{directives.length > 100 ? "..." : ""}
                </div>
              )}
            </div>

            {messages.length > 0 && (
              <div style={{ display: "flex", gap: "10px", marginBottom: "16px", alignItems: "center" }}>
                <Btn v="primary" onClick={approveAll}>Aprobar todos</Btn>
                <Btn v="outline" onClick={disapproveAll}>Desaprobar todos</Btn>
                <div style={{ marginLeft: "auto", fontSize: "13px", display: "flex", gap: "12px", alignItems: "center" }}>
                  <span style={{ color: C.success, fontWeight: 600 }}>{approved} aprobados</span>
                  <span style={{ color: C.textMuted }}>{messages.length - approved} pendientes</span>
                  {hasErrors && <span style={{ color: "#C0392B", fontWeight: 600 }}>{messages.filter(isErrorMsg).length} con error</span>}
                </div>
              </div>
            )}

            {messages.length === 0 ? (
              <div style={card({ textAlign: "center", padding: "40px" })}>
                <div style={{ fontSize: "14px", color: C.textMuted }}>Sin mensajes generados</div>
              </div>
            ) : (
              messages.map(msg => {
                const c = contacts.find(x => x.id === msg.contact_id);
                const isEdit = editId === msg.id;
                const hasErr = isErrorMsg(msg);
                const chans = campaign.channels || ["linkedin", "email"];
                return (
                  <div key={msg.id} style={card({
                    marginBottom: "12px",
                    borderLeft: "4px solid " + (hasErr ? "#C0392B" : msg.approved ? C.success : C.border),
                  })}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: "14px", color: C.text }}>{c?.name || "Contacto"}</div>
                        <div style={{ fontSize: "12px", color: C.textMuted }}>
                          {c?.title || ""}{c?.company ? " · " + c.company : ""}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                        {hasErr && <Badge color="red">Error</Badge>}
                        <Btn v="ghost" onClick={() => setEditId(isEdit ? null : msg.id)}>{isEdit ? "Cerrar" : "Editar"}</Btn>
                        <Btn v={msg.approved ? "success" : "outline"} onClick={() => toggleApprove(msg)} style={{ fontSize: "11px", padding: "4px 12px" }}>
                          {msg.approved ? "✓ Aprobado" : "Aprobar"}
                        </Btn>
                      </div>
                    </div>

                    {chans.includes("linkedin") && (msg.linkedin || []).map((li, idx) => (
                      <div key={idx} style={{ marginBottom: "6px" }}>
                        <div style={{ fontSize: "10px", fontWeight: 700, color: C.info, textTransform: "uppercase", marginBottom: "4px" }}>
                          LinkedIn {(msg.linkedin || []).length > 1 ? (idx === 0 ? "· Inicial" : "· Followup " + idx) : ""}
                        </div>
                        {isEdit ? (
                          <textarea
                            value={li}
                            onChange={e => {
                              const arr = [...msg.linkedin]; arr[idx] = e.target.value;
                              messagesRepo.update(msg.id, { linkedin: arr }).then(loadAll);
                            }}
                            style={{ ...INP, height: "80px", resize: "vertical", fontSize: "12px" }}
                          />
                        ) : (
                          <div style={{ fontSize: "13px", color: C.textMd, background: C.pageBg, borderRadius: "6px", padding: "10px 12px", lineHeight: 1.6 }}>{li}</div>
                        )}
                      </div>
                    ))}

                    {chans.includes("email") && (msg.email || []).map((em, idx) => (
                      <div key={idx} style={{ marginBottom: "8px", background: C.pageBg, borderRadius: "8px", padding: "10px 12px" }}>
                        <div style={{ fontSize: "10px", fontWeight: 700, color: C.warn, textTransform: "uppercase", marginBottom: "6px" }}>
                          Email {(msg.email || []).length > 1 ? (idx === 0 ? "· Inicial" : "· Followup " + idx) : ""}
                        </div>
                        {isEdit ? (
                          <>
                            <input value={em.subject || ""} onChange={e => {
                              const arr = [...msg.email]; arr[idx] = { ...arr[idx], subject: e.target.value };
                              messagesRepo.update(msg.id, { email: arr }).then(loadAll);
                            }} placeholder="Asunto" style={{ ...INP, marginBottom: "6px", fontSize: "12px" }} />
                            <textarea value={em.body || ""} onChange={e => {
                              const arr = [...msg.email]; arr[idx] = { ...arr[idx], body: e.target.value };
                              messagesRepo.update(msg.id, { email: arr }).then(loadAll);
                            }} style={{ ...INP, height: "100px", resize: "vertical", fontSize: "12px" }} />
                          </>
                        ) : (
                          <>
                            <div style={{ fontSize: "12px", fontWeight: 600, color: C.text, marginBottom: "4px" }}>Asunto: {em.subject}</div>
                            <div style={{ fontSize: "13px", color: C.textMd, lineHeight: 1.6 }}>{em.body}</div>
                          </>
                        )}
                      </div>
                    ))}

                    {chans.includes("whatsapp") && (msg.whatsapp || []).map((wa, idx) => (
                      <div key={idx} style={{ marginBottom: "6px" }}>
                        <div style={{ fontSize: "10px", fontWeight: 700, color: C.success, textTransform: "uppercase", marginBottom: "4px" }}>
                          WhatsApp {(msg.whatsapp || []).length > 1 ? (idx === 0 ? "· Inicial" : "· Followup " + idx) : ""}
                        </div>
                        <div style={{ fontSize: "13px", color: C.textMd, background: C.successBg, borderRadius: "6px", padding: "10px 12px", lineHeight: 1.6 }}>{wa}</div>
                      </div>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* SOURCES TAB */}
        {tab === "sources" && (
          <div>
            {!client && (
              <div style={{ fontSize: "13px", color: C.textMuted, padding: "10px 14px", background: C.warnBg, borderRadius: "8px", marginBottom: "16px" }}>
                Sin cliente asociado — no se pueden gestionar fuentes.
              </div>
            )}
            {client && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "16px" }}>
                  <div style={{ background: C.pageBg, border: "1px solid " + C.border, borderRadius: "8px", padding: "12px" }}>
                    <div style={{ fontSize: "12px", fontWeight: 600, color: C.textMd, marginBottom: "8px" }}>Agregar URL</div>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <input
                        style={{ ...INP, fontSize: "12px", padding: "7px 10px" }}
                        value={newSrcUrl}
                        onChange={e => setNewSrcUrl(e.target.value)}
                        placeholder="https://empresa.com"
                        onKeyDown={e => e.key === "Enter" && addSrcUrl()}
                      />
                      <Btn v="purple" onClick={addSrcUrl} style={{ padding: "7px 12px", fontSize: "13px" }}>+</Btn>
                    </div>
                  </div>
                  <div style={{ background: C.pageBg, border: "1px solid " + C.border, borderRadius: "8px", padding: "12px" }}>
                    <div style={{ fontSize: "12px", fontWeight: 600, color: C.textMd, marginBottom: "8px" }}>
                      Subir documentos
                      <span style={{ fontWeight: 400, color: C.textFaint, marginLeft: "6px" }}>.pdf · .txt · .md</span>
                    </div>
                    <div
                      onClick={() => !srcUploading && srcDocRef.current?.click()}
                      style={{
                        border: "2px dashed " + C.borderMd, borderRadius: "6px", padding: "14px 8px",
                        textAlign: "center", cursor: srcUploading ? "default" : "pointer",
                        fontSize: "12px", color: C.textMuted,
                      }}
                    >
                      {srcUploading ? "Subiendo..." : "Haz clic o arrastra archivos (puedes seleccionar varios)"}
                    </div>
                    <input ref={srcDocRef} type="file" accept=".pdf,.txt,.md" multiple style={{ display: "none" }} onChange={handleSrcDocSelect} />

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
                            <span style={{ fontSize: "12px", color: "#C0392B", fontWeight: 700 }}>PDF</span>
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
                          disabled={srcUploading}
                          style={{ marginTop: "8px", width: "100%", justifyContent: "center" }}
                        >
                          {srcUploading ? "Subiendo..." : `Subir ${pendingFiles.length} archivo${pendingFiles.length !== 1 ? "s" : ""}`}
                        </Btn>
                      </div>
                    )}
                  </div>
                </div>

                {sources.length === 0 ? (
                  <div style={card({ textAlign: "center", padding: "40px" })}>
                    <div style={{ fontSize: "14px", color: C.textMuted }}>Sin fuentes — agrega URLs o documentos arriba.</div>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: "12px", color: C.textMuted, marginBottom: "10px" }}>
                      {sources.length} fuente{sources.length !== 1 ? "s" : ""} · se usan automáticamente al generar mensajes
                    </div>
                    {sources.map(s => (
                      <div key={s.id} style={card({ marginBottom: "8px", display: "flex", alignItems: "center", gap: "12px" })}>
                        <Badge color={s.type === "url" ? "blue" : s.type === "pdf" ? "red" : "amber"}>{s.type}</Badge>
                        <div style={{ flex: 1, fontSize: "13px", color: C.textMd, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {s.type === "url" ? s.url : s.name}
                        </div>
                        {s.type === "url" && <a href={s.url} target="_blank" rel="noreferrer" style={{ fontSize: "11px", color: C.info }}>Abrir →</a>}
                        <Btn v="danger" onClick={() => deleteSrc(s.id)}>×</Btn>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* PERSONA TAB */}
        {tab === "persona" && (
          <div>
            <div style={{ marginBottom: "16px" }}>
              <Btn v="primary" onClick={handleGenPersona} disabled={genPersona}>
                {genPersona ? "Generando..." : persona ? "Regenerar buyer persona" : "Generar buyer persona con IA"}
              </Btn>
            </div>
            {!persona ? (
              <div style={card({ textAlign: "center", padding: "48px" })}>
                <div style={{ fontSize: "32px", marginBottom: "12px" }}>👤</div>
                <div style={{ fontSize: "14px", fontWeight: 600, color: C.textMd, marginBottom: "8px" }}>Sin buyer persona</div>
                <div style={{ fontSize: "12px", color: C.textFaint }}>Genera el perfil del prospecto ideal para este segmento.</div>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <div style={card()}>
                  <div style={{ display: "flex", gap: "12px", alignItems: "center", marginBottom: "14px" }}>
                    <div style={{ width: "44px", height: "44px", borderRadius: "50%", background: C.purpleBg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px", fontWeight: 700, color: C.purple }}>{(persona.name || "?")[0]}</div>
                    <div>
                      <div style={{ fontSize: "16px", fontWeight: 700, color: C.text }}>{persona.name}</div>
                      <div style={{ fontSize: "12px", color: C.textMuted }}>{persona.title}</div>
                    </div>
                  </div>
                  <div style={{ fontSize: "13px", color: C.textMd, lineHeight: 1.7 }}>{persona.summary}</div>
                </div>
                <div style={card()}>
                  {([
                    ["Pain Points", persona.pains, C.accent, C.accentBg],
                    ["Motivaciones", persona.motivations, C.success, C.successBg],
                    ["Objeciones", persona.objections, C.warn, C.warnBg],
                  ] as const).map(([l, items, col, bg]) => (
                    <div key={l} style={{ marginBottom: "14px" }}>
                      <div style={{ fontSize: "11px", fontWeight: 700, color: C.textMuted, marginBottom: "6px", textTransform: "uppercase" }}>{l}</div>
                      <div style={{ background: bg, borderRadius: "6px", padding: "8px 12px" }}>
                        {(items || []).map((item, idx) => (
                          <div key={idx} style={{ fontSize: "12px", color: C.textMd, padding: "3px 0", display: "flex", gap: "6px" }}>
                            <span style={{ color: col, fontWeight: 700 }}>-</span>{item}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* SIMULATOR TAB */}
        {tab === "simulator" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
              <Btn
                v="primary"
                onClick={handleSimulate}
                disabled={simLoading || messages.filter(m => !isErrorMsg(m)).length === 0}
              >
                {simLoading ? "Simulando..." : simResult ? "↻ Re-simular" : "Iniciar simulación"}
              </Btn>
              {messages.filter(m => !isErrorMsg(m)).length === 0 && (
                <span style={{ fontSize: "12px", color: C.textMuted }}>
                  Genera mensajes en la pestaña Mensajes primero
                </span>
              )}
              {simResult && !simLoading && (
                <span style={{ fontSize: "12px", color: C.textMuted }}>
                  Basado en {Math.min(messages.filter(m => !isErrorMsg(m)).length, 6)} mensajes
                  {persona ? ` · Persona: ${persona.name}` : " · Perfil genérico"}
                </span>
              )}
            </div>

            {simLoading && (
              <div style={card({ textAlign: "center", padding: "56px" })}>
                <div style={{ fontSize: "36px", marginBottom: "14px" }}>🧠</div>
                <div style={{ fontSize: "14px", fontWeight: 600, color: C.textMd, marginBottom: "6px" }}>
                  Simulando audiencia virtual...
                </div>
                <div style={{ fontSize: "12px", color: C.textFaint }}>
                  Analizando mensajes y calculando métricas de apertura, respuesta e interés
                </div>
              </div>
            )}

            {!simResult && !simLoading && (
              <div style={card({ textAlign: "center", padding: "56px" })}>
                <div style={{ fontSize: "36px", marginBottom: "14px" }}>🎯</div>
                <div style={{ fontSize: "15px", fontWeight: 700, color: C.textMd, marginBottom: "10px" }}>
                  Simulador de mensajes
                </div>
                <div style={{ fontSize: "13px", color: C.textFaint, maxWidth: "420px", margin: "0 auto", lineHeight: 1.6 }}>
                  Crea un público virtual basado en el buyer persona y expone los mensajes generados.
                  Obtén tasa de apertura, tasa de respuesta e interés generado, más insights con puntos
                  fuertes, debilidades y sugerencias.
                </div>
              </div>
            )}

            {simResult && !simLoading && (
              <div>
                {/* KPI cards */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "14px", marginBottom: "20px" }}>
                  <div style={card({ textAlign: "center", padding: "24px 20px" })}>
                    <div style={{ fontSize: "11px", fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "10px" }}>
                      Tasa de Apertura
                    </div>
                    <div style={{ fontSize: "40px", fontWeight: 800, color: C.accent, lineHeight: 1 }}>
                      {simResult.open_rate}%
                    </div>
                    <div style={{ fontSize: "11px", color: C.textFaint, marginTop: "6px" }}>de la audiencia virtual</div>
                  </div>
                  <div style={card({ textAlign: "center", padding: "24px 20px" })}>
                    <div style={{ fontSize: "11px", fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "10px" }}>
                      Tasa de Respuesta
                    </div>
                    <div style={{ fontSize: "40px", fontWeight: 800, color: C.success, lineHeight: 1 }}>
                      {simResult.response_rate}%
                    </div>
                    <div style={{ fontSize: "11px", color: C.textFaint, marginTop: "6px" }}>probabilidad de respuesta</div>
                  </div>
                  <div style={card({ textAlign: "center", padding: "24px 20px" })}>
                    <div style={{ fontSize: "11px", fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "10px" }}>
                      Interés Generado
                    </div>
                    <div style={{ fontSize: "40px", fontWeight: 800, color: C.purple, lineHeight: 1 }}>
                      {simResult.interest_score}%
                    </div>
                    <div style={{ marginTop: "8px" }}>
                      <Badge color={simResult.interest_level === "alto" ? "green" : simResult.interest_level === "medio" ? "amber" : "gray"}>
                        {simResult.interest_level.charAt(0).toUpperCase() + simResult.interest_level.slice(1)}
                      </Badge>
                    </div>
                  </div>
                </div>

                {/* Reactions table */}
                {simResult.reactions.length > 0 && (
                  <div style={card({ marginBottom: "16px", padding: 0, overflow: "hidden" })}>
                    <div style={{ padding: "14px 18px", borderBottom: "1px solid " + C.border, background: C.pageBg }}>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: C.text }}>
                        Reacciones del público virtual
                      </div>
                    </div>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                      <thead>
                        <tr>
                          {["Contacto", "Canal", "Abre", "Responde", "Interés", "Comentario"].map(h => (
                            <th key={h} style={TH}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {simResult.reactions.map((r, idx) => (
                          <tr key={idx}>
                            <td style={TD}>{r.contact_name}</td>
                            <td style={TD}>
                              <Badge color={r.channel === "linkedin" ? "blue" : r.channel === "email" ? "amber" : "green"}>
                                {r.channel}
                              </Badge>
                            </td>
                            <td style={TD}>{r.opens ? "✅" : "❌"}</td>
                            <td style={TD}>{r.responds ? "✅" : "❌"}</td>
                            <td style={TD}>
                              <Badge color={r.interest === "alto" ? "green" : r.interest === "medio" ? "amber" : "gray"}>
                                {r.interest}
                              </Badge>
                            </td>
                            <td style={{ ...TD, color: C.textMuted, fontStyle: "italic", fontSize: "11px" }}>
                              {r.comment}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Insights */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "14px", marginBottom: "20px" }}>
                  <div style={card({ borderTop: "3px solid " + C.success })}>
                    <div style={{ fontSize: "11px", fontWeight: 700, color: C.success, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "14px" }}>
                      Puntos Fuertes
                    </div>
                    {(simResult.insights.strengths || []).map((s, i) => (
                      <div key={i} style={{ display: "flex", gap: "8px", marginBottom: "10px", fontSize: "12px", color: C.textMd, lineHeight: 1.5 }}>
                        <span style={{ color: C.success, fontWeight: 800, flexShrink: 0 }}>✓</span>
                        {s}
                      </div>
                    ))}
                  </div>
                  <div style={card({ borderTop: "3px solid #C0392B" })}>
                    <div style={{ fontSize: "11px", fontWeight: 700, color: "#C0392B", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "14px" }}>
                      Debilidades
                    </div>
                    {(simResult.insights.weaknesses || []).map((w, i) => (
                      <div key={i} style={{ display: "flex", gap: "8px", marginBottom: "10px", fontSize: "12px", color: C.textMd, lineHeight: 1.5 }}>
                        <span style={{ color: "#C0392B", fontWeight: 800, flexShrink: 0 }}>✗</span>
                        {w}
                      </div>
                    ))}
                  </div>
                  <div style={card({ borderTop: "3px solid " + C.info })}>
                    <div style={{ fontSize: "11px", fontWeight: 700, color: C.info, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "14px" }}>
                      Sugerencias
                    </div>
                    {(simResult.insights.suggestions || []).map((sg, i) => (
                      <div key={i} style={{ display: "flex", gap: "8px", marginBottom: "10px", fontSize: "12px", color: C.textMd, lineHeight: 1.5 }}>
                        <span style={{ color: C.info, fontWeight: 800, flexShrink: 0 }}>{i + 1}.</span>
                        {sg}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Apply suggestions */}
                <div style={card({ background: C.infoBg, border: "1px solid " + C.info + "44" })}>
                  <div style={{ fontSize: "14px", fontWeight: 700, color: C.text, marginBottom: "6px" }}>
                    Aplicar sugerencias y regenerar
                  </div>
                  <div style={{ fontSize: "12px", color: C.textMd, marginBottom: "16px", lineHeight: 1.6 }}>
                    Regenera todos los mensajes incorporando las {(simResult.insights.suggestions || []).length} sugerencias
                    identificadas por la simulación. Las sugerencias se añadirán como directrices de generación y todos
                    los mensajes del segmento serán reemplazados.
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <Btn v="primary" onClick={handleApplySuggestions} disabled={isGenerating}>
                      {isGenerating ? "Regenerando..." : "Aplicar sugerencias y regenerar mensajes"}
                    </Btn>
                    {isGenerating && (
                      <span style={{ fontSize: "12px", color: C.textMuted }}>
                        Puedes seguir el progreso en la pestaña Mensajes
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* LEMLIST TAB */}
        {tab === "lemlist" && (
          <LemlistPushPanel
            client={client}
            segmentName={segment.name}
            contacts={contacts}
            messages={messages}
          />
        )}
      </div>
    </div>
  );
}

// ─── ColumnMapper (modal) ─────────────────────────────────────────────────────
function ColumnMapper({
  rawData, onConfirm, onCancel,
}: {
  rawData: { headers: string[]; rows: string[][] };
  onConfirm: (parsed: Record<string, string>[]) => void;
  onCancel: () => void;
}) {
  const { headers, rows } = rawData;

  const autoMap = (): Record<string, number | ""> => {
    const aliases: Record<string, string[]> = {
      name: ["nombre", "name", "first_name", "contacto"],
      title: ["cargo", "title", "position", "role"],
      company: ["empresa", "company", "companyname"],
      email: ["email", "correo", "e_mail"],
      country: ["pais", "país", "country", "region"],
      decision_maker: ["tomador", "decision", "decision_maker", "decisor"],
      linkedin: ["linkedin", "linkedin_url"],
      website: ["website", "sitio_web", "web", "url_empresa"],
      phone: ["telefono", "phone", "celular"],
    };
    const map: Record<string, number | ""> = {};
    headers.forEach((h, i) => {
      const hn = h.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
      Object.entries(aliases).forEach(([field, list]) => {
        if (!Object.prototype.hasOwnProperty.call(map, field) && list.some(a => hn.includes(a))) {
          map[field] = i;
        }
      });
    });
    return map;
  };

  const [colMap, setColMap] = useState<Record<string, number | "">>(() => {
    const auto = autoMap();
    return Object.fromEntries(
      Object.keys(FIELD_LABELS).map(f => [f, Object.prototype.hasOwnProperty.call(auto, f) ? auto[f] : ""]),
    );
  });

  const parsed = applyColumnMap(rawData, colMap);

  return (
    <Modal title="Mapear columnas del CSV" onClose={onCancel} width="700px">
      <div style={{ fontSize: "13px", color: C.textMd, marginBottom: "18px" }}>
        <strong>{headers.length} columnas</strong>, <strong>{rows.length} filas</strong>.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "20px" }}>
        {Object.entries(FIELD_LABELS).map(([field, label]) => (
          <div key={field}>
            <label style={{ fontSize: "12px", fontWeight: 600, color: C.textMd, marginBottom: "6px", display: "block" }}>
              {label}{(field === "name" || field === "email") ? " *" : ""}
            </label>
            <select
              value={colMap[field] === "" ? "" : colMap[field]}
              onChange={e => setColMap(p => ({ ...p, [field]: e.target.value === "" ? "" : parseInt(e.target.value) }))}
              style={{ ...INP, cursor: "pointer" }}
            >
              <option value="">— No incluir —</option>
              {headers.map((h, i) => (
                <option key={i} value={i}>{h}{rows[0]?.[i] ? " → " + rows[0][i].slice(0, 20) : ""}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
        <Btn v="ghost" onClick={onCancel}>Cancelar</Btn>
        <Btn v="primary" onClick={() => onConfirm(parsed)} disabled={parsed.length === 0}>
          Importar {parsed.length} contactos
        </Btn>
      </div>
    </Modal>
  );
}

// ─── LemlistPushPanel ─────────────────────────────────────────────────────────
function LemlistPushPanel({
  client, segmentName, contacts, messages,
}: {
  client: Client | null;
  segmentName: string;
  contacts: BullseyeContact[];
  messages: BullseyeMessage[];
}) {
  const [campaigns, setCampaigns] = useState<Array<{ _id: string; name: string }>>([]);
  const [selCamp, setSelCamp] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ campId: string; sent: number } | null>(null);
  const approved = messages.filter(m => m.approved);
  const hasKey = !!client?.bullseye_lemlist_api_key_encrypted;

  const fetchCamps = async () => {
    if (!client) return;
    setLoading(true); setErr(null);
    try {
      const data = await callLemlist(client.id, "GET", "/api/campaigns");
      setCampaigns(Array.isArray(data) ? data as Array<{ _id: string; name: string }> : []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  };

  const handleSend = async () => {
    if (!client) return;
    setSending(true); setErr(null);
    try {
      let campId = selCamp;
      if (!campId) {
        const camp = await callLemlist(client.id, "POST", "/api/campaigns", { name: "[BullsEye] " + segmentName }) as { _id: string };
        campId = camp._id;
      }
      let sent = 0;
      for (const contact of contacts) {
        const msg = approved.find(m => m.contact_id === contact.id);
        if (!msg || !contact.email) continue;
        const parts = (contact.name || "").split(" ");
        try {
          await callLemlist(client.id, "POST", `/api/campaigns/${campId}/leads/${encodeURIComponent(contact.email)}`, {
            firstName: parts[0],
            lastName: parts.slice(1).join(" "),
            companyName: contact.company,
            linkedinUrl: contact.linkedin,
            icebreaker: msg.linkedin?.[0],
            emailSubject: msg.email?.[0]?.subject,
            emailBody: msg.email?.[0]?.body,
          });
          sent++;
        } catch (e) {
          console.warn("Error con lead", contact.email, e);
        }
      }
      setResult({ campId, sent });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setSending(false);
  };

  if (!client) {
    return (
      <div style={card({ textAlign: "center", padding: "40px" })}>
        <div style={{ fontSize: "14px", color: C.textMuted }}>No se encontró el cliente asociado</div>
      </div>
    );
  }

  if (!hasKey) {
    return (
      <div style={card({ background: C.warnBg, border: "1px solid " + C.warn + "44" })}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: C.warn, marginBottom: "8px" }}>
          ⚠️ Sin API key de Lemlist para {client.name}
        </div>
        <div style={{ fontSize: "13px", color: C.textMd, marginBottom: "12px" }}>
          Ve a <strong>Clientes</strong> → busca <strong>{client.name}</strong> → click en <strong>🔑 Lemlist</strong> y configura su API key.
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div style={card({ textAlign: "center", padding: "32px" })}>
        <div style={{ fontSize: "32px", marginBottom: "12px" }}>✅</div>
        <div style={{ fontSize: "16px", fontWeight: 700, color: C.success, marginBottom: "8px" }}>¡Enviado correctamente!</div>
        <div style={{ fontSize: "13px", color: C.textMd }}>
          {result.sent} contactos enviados a Lemlist (Campaign ID: {result.campId})
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ background: C.infoBg, border: "1px solid " + C.info + "44", borderRadius: "8px", padding: "10px 14px", fontSize: "12px", color: C.textMd, marginBottom: "16px" }}>
        Solo se enviarán los <strong>{approved.length} contactos aprobados</strong> con email válido.
      </div>
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px", alignItems: "center" }}>
        <Btn v="ghost" onClick={fetchCamps} disabled={loading}>{loading ? "Cargando..." : "Cargar campañas existentes"}</Btn>
      </div>
      {campaigns.length > 0 && (
        <div style={{ marginBottom: "16px" }}>
          <label style={{ fontSize: "12px", fontWeight: 600, color: C.textMd, marginBottom: "6px", display: "block" }}>
            Campaña existente (opcional)
          </label>
          <select value={selCamp} onChange={e => setSelCamp(e.target.value)} style={{ ...INP, cursor: "pointer" }}>
            <option value="">— Crear nueva campaña —</option>
            {campaigns.map(c => <option key={c._id} value={c._id}>{c.name}</option>)}
          </select>
        </div>
      )}
      {err && (
        <div style={{ padding: "12px 14px", background: "#FFF5F5", border: "1px solid #FACCCC", borderRadius: "8px", fontSize: "12px", color: "#C0392B", marginBottom: "14px" }}>
          {err}
        </div>
      )}
      <Btn v="primary" onClick={handleSend} disabled={sending || approved.length === 0}>
        {sending ? "Enviando..." : `Enviar ${approved.length} contactos a Lemlist`}
      </Btn>
    </div>
  );
}
