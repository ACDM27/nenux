import { useState } from "react";
import { imApi, type ImContact, type ImMember } from "../imClient";

export function ImMembersPanel({ conversationId, userId, members, contacts, updated }: {
  conversationId: string; userId: string; members: ImMember[]; contacts: ImContact[]; updated: (members: ImMember[]) => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canManage = members.some(member => member.userOrBotId === userId && ["owner", "admin"].includes(member.role));
  const change = async (id: string, remove = false) => {
    setBusy(true); setError("");
    try { await updated(await imApi.changeMember(conversationId, userId, id, remove)); setTarget(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <section className="im-task-panel" aria-label="群成员管理">
    <strong>群成员</strong>
    {error && <p role="alert">{error}</p>}
    {members.map(member => <div key={member.userOrBotId}>
      {contacts.find(contact => contact.id === member.userOrBotId)?.name || member.userOrBotId} · {member.role === "owner" ? "群主" : member.role === "admin" ? "管理员" : "成员"}
      {canManage && member.role !== "owner" && <button disabled={busy} onClick={() => void change(member.userOrBotId, true)}>移除 {contacts.find(contact => contact.id === member.userOrBotId)?.name || member.userOrBotId}</button>}
    </div>)}
    {canManage && <form onSubmit={event => { event.preventDefault(); void change(target); }}>
      <label>添加成员<select value={target} onChange={event => setTarget(event.target.value)}>
        <option value="">选择联系人</option>
        {contacts.filter(contact => !members.some(member => member.userOrBotId === contact.id)).map(contact => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
      </select></label>
      <button disabled={!target || busy} type="submit">添加到群</button>
    </form>}
  </section>;
}
