import { useEffect, useState } from "react";
import { imApi, type ImContact, type ImMember, type ImHandoffPreview, type ImHandoffResult } from "../imClient";

export function ImHandoffPanel({ conversationId, userId, members, contacts, openConversation }: {
  conversationId: string; userId: string; members: ImMember[]; contacts: ImContact[]; openConversation: (id: string) => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [source, setSource] = useState(userId);
  const [mode, setMode] = useState<"rules" | "llm">("rules");
  const [projectPath, setProjectPath] = useState("");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<ImHandoffPreview>();
  const [records, setRecords] = useState<Array<ImHandoffResult & { snapshot: { snapshotId: string; target: string } }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [llmConfigured, setLlmConfigured] = useState(false);
  useEffect(() => {
    let active = true;
    imApi.capabilities().then(data => { if (active) setLlmConfigured(data.llmConfigured); }).catch(() => {});
    imApi.executionSettings(conversationId, userId).then(settings => { if (active) setProjectPath(settings.cwd); }).catch(() => {});
    imApi.listHandoffs(conversationId, userId).then(data => { if (active) setRecords(data); }).catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [conversationId, userId]);
  const action = async (execute: () => Promise<unknown>) => {
    setError(""); setBusy(true);
    try { await execute(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const invalidate = () => setPreview(undefined);
  return <section className="im-handoff-panel" aria-label="跨智能体接力">
    <form className="im-task-settings" onSubmit={event => { event.preventDefault(); void action(async () => {
      setPreview(await imApi.handoffPreview(conversationId, source, target, { userId, mode, projectPath, handoffNote: note }));
    }); }}>
      <label>来源成员<select value={source} onChange={event => { setSource(event.target.value); invalidate(); }}>
        {members.map(member => <option key={member.userOrBotId} value={member.userOrBotId}>{contacts.find(contact => contact.id === member.userOrBotId)?.name || member.userOrBotId}</option>)}
      </select></label>
      <label>目标智能体<select required value={target} onChange={event => { setTarget(event.target.value); invalidate(); }}>
        <option value="">选择智能体</option>{contacts.filter(contact => contact.type === "bot").map(contact => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
      </select></label>
      <label>摘要模式<select value={mode} onChange={event => { setMode(event.target.value as "rules" | "llm"); invalidate(); }}>
        <option value="rules">规则摘要</option><option value="llm" disabled={!llmConfigured}>{llmConfigured ? "LLM 摘要（调用失败会明确回退）" : "LLM 摘要（请先配置默认模型及 API Key）"}</option>
      </select></label>
      <label>项目目录<input value={projectPath} onChange={event => { setProjectPath(event.target.value); invalidate(); }} /></label>
      <label className="im-handoff-note">接力说明<textarea value={note} maxLength={8000} onChange={event => { setNote(event.target.value); invalidate(); }} /></label>
      <button type="submit" disabled={!target || busy}>{busy ? "处理中…" : "生成接力预览"}</button>
    </form>
    {error && <p role="alert" className="im-error">{error}</p>}
    {preview && <div className="im-handoff-preview">
      <p>实际摘要模式：{preview.snapshot.distillMode === "llm" ? "LLM" : "规则"}</p>
      {preview.snapshot.warnings.map((warning, index) => <p role="status" key={index}>{warning}</p>)}
      <pre>{preview.rendered}</pre>
      <button disabled={busy} onClick={() => void action(async () => {
        const result = await imApi.executeHandoff(conversationId, source, target, { userId, previewId: preview.previewId });
        await openConversation(result.targetConversationId);
      })}>执行此预览并打开目标会话</button>
    </div>}
    {!!records.length && <details><summary>历史接力（状态以目标任务为准）</summary>{records.map(record => <div key={record.snapshot.snapshotId}>
      {contacts.find(contact => contact.id === record.snapshot.target)?.name || record.snapshot.target} · {record.status}
      {record.targetConversationId && <button onClick={() => void action(() => openConversation(record.targetConversationId))}>查看执行</button>}
    </div>)}</details>}
  </section>;
}
