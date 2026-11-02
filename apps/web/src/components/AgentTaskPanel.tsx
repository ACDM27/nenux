import { useEffect, useState } from "react";
import type { ImExecutionSettings, ImTask } from "@termany/core";
import { imApi, type ImMember, type ImContact } from "../imClient";
import { useImStore } from "../imStore";

const statusText = { queued: "排队中", running: "执行中", succeeded: "已完成", failed: "失败", cancelled: "已取消" };

export function AgentTaskPanel({ conversationId, userId, members, contacts }: {
  conversationId: string; userId: string; members: ImMember[]; contacts: ImContact[];
}) {
  const [tasks, setTasks] = useState<ImTask[]>([]);
  const [settings, setSettings] = useState<ImExecutionSettings>();
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [reload, setReload] = useState(0);
  const lastEvent = useImStore(state => state.lastEvent);
  const canConfigure = members.some(member => member.userOrBotId === userId && ["owner", "admin"].includes(member.role));
  useEffect(() => {
    let active = true;
    setTasks([]); setSettings(undefined); setError("");
    imApi.executionSettings(conversationId, userId).then(data => { if (active) setSettings(data); })
      .catch(reason => { if (active) setError(String(reason.message || reason)); });
    return () => { active = false; };
  }, [conversationId, userId]);
  useEffect(() => {
    let active = true;
    const refresh = () => imApi.listTasks(conversationId, userId).then(data => { if (active) { setTasks(data); setLoadError(""); } })
      .catch(reason => { if (active) setLoadError(String(reason.message || reason)); });
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [conversationId, userId, reload]);
  useEffect(() => {
    if (lastEvent?.type === "im.task.updated") setReload(value => value + 1);
  }, [lastEvent]);
  const action = async (execute: () => Promise<unknown>) => {
    setError("");
    try { await execute(); setReload(value => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <section className="im-task-panel" aria-label="智能体协作任务">
    <div className="im-task-heading"><strong>协作任务</strong><button onClick={() => setShowSettings(!showSettings)}>执行设置</button></div>
    {(error || loadError) && <div role="alert" className="im-error">{error || loadError}<button onClick={() => { setError(""); setLoadError(""); }}>关闭</button></div>}
    {showSettings && settings && <form className="im-task-settings" onSubmit={event => {
      event.preventDefault(); setSaving(true);
      void action(() => imApi.configureExecution(conversationId, userId, settings)).finally(() => setSaving(false));
    }}>
      <label>项目目录<input value={settings.cwd} disabled={!canConfigure} onChange={event => setSettings({ ...settings, cwd: event.target.value })} /></label>
      <label>负责人<select value={settings.leadAgentId || members.find(member => member.memberType === "bot")?.userOrBotId || ""} disabled={!canConfigure}
        onChange={event => setSettings({ ...settings, leadAgentId: event.target.value })}>
        {members.filter(member => member.memberType === "bot").map(member => <option key={member.userOrBotId} value={member.userOrBotId}>{contacts.find(contact => contact.id === member.userOrBotId)?.name || member.userOrBotId}</option>)}
      </select></label>
      <label>轮数上限<input type="number" min={1} max={24} value={settings.maxTurns} disabled={!canConfigure} onChange={event => setSettings({ ...settings, maxTurns: Number(event.target.value) })} /></label>
      <label>超时（秒）<input type="number" min={1} max={1800} value={settings.timeoutMs / 1000} disabled={!canConfigure} onChange={event => setSettings({ ...settings, timeoutMs: Number(event.target.value) * 1000 })} /></label>
      {canConfigure && <button disabled={saving} type="submit">{saving ? "保存中…" : "保存设置"}</button>}
    </form>}
    {!tasks.length && <p className="im-chat-sub">给智能体发消息即可创建任务。</p>}
    {tasks.slice(0, 20).map(task => <details key={task.id} open={task.status === "running"}>
      <summary>{statusText[task.status]} · 第 {task.attempt} 次执行 · {new Date(task.createdAt).toLocaleTimeString()}</summary>
      {task.error && <p role="alert">{task.error}</p>}
      {task.parentTaskId && <p className="im-chat-sub">已成功且输入一致的步骤自动复用。中断步骤仍需核对上一轮产生的文件和外部操作。</p>}
      {task.steps.map((step, index) => <div className="im-task-step" key={index}>
        <strong>{contacts.find(contact => contact.id === step.agentId)?.name || step.agentId}</strong> · {step.status === "running" ? "处理中" : step.status === "succeeded" ? "已返回" : "失败"}
        {step.error && <p>{step.error}</p>}<pre>{step.text}</pre>
        {step.reusedFromTaskId && <span className="im-chat-sub">已复用此前成功步骤，未再次调用智能体。</span>}
        {task.status === "running" && step.permission && <div role="group" aria-label="智能体操作授权">
          <p>{step.permission.title}</p>
          {step.permission.options.map(option => <button key={option.optionId} onClick={() => void action(() => imApi.respondTaskPermission(task.id, userId, step.permission!.requestId, option.optionId))}>{option.name}</button>)}
        </div>}
      </div>)}
      {["queued", "running"].includes(task.status) && <button onClick={() => void action(() => imApi.cancelTask(task.id, userId))}>取消任务</button>}
      {["failed", "cancelled"].includes(task.status) && <button onClick={() => void action(() => imApi.retryTask(task.id, userId))}>重新执行</button>}
      {task.resultMessageId && <span className="im-chat-sub">结果已保存到当前会话</span>}
    </details>)}
  </section>;
}
