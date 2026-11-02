import type { Language } from "./i18n";
import { uuid } from "./uuid";

export interface GreetingBotProfile {
  id?: string;
  name: string;
  description?: string;
  labels?: string;
}

export interface GreetingGroupProfile {
  name: string;
  description?: string;
  humanName?: string;
  members: GreetingBotProfile[];
}

export interface AgentGreetingContext {
  bot: GreetingBotProfile;
  group?: GreetingGroupProfile;
  language: Language;
  now?: Date;
  timeZone?: string;
  variation?: string;
}

/** Build a one-turn prompt for a new Topic's proactive greeting. The model
 * receives concrete local calendar context; it decides whether a holiday or
 * seasonal reference is actually relevant instead of the client maintaining
 * an incomplete worldwide holiday table. */
export function agentGreetingPrompt({
  bot,
  group,
  language,
  now = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  variation = uuid(),
}: AgentGreetingContext): string {
  const localDateTime = new Intl.DateTimeFormat(language, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  }).format(now);

  return [
    "Write the proactive opening greeting for a brand-new chat topic.",
    "Reply with exactly one short, natural sentence and nothing else: no Markdown, heading, list, quotation marks, or explanation.",
    "Write in interface.language. Speak as currentBot and let its name, description, and labels shape the wording and personality without mechanically listing them.",
    "Use the local date and time naturally when useful. Consider a widely recognized holiday, festival, weekday, season, or time of day for this language and timezone, but mention one only when relevant and confident; never invent an occasion or precise location.",
    "Vary the greeting across topics. Do not default to a generic equivalent of 'What can I do for you?'. Do not call tools or claim that any work has already been done.",
    group
      ? "This is a group chat. currentBot is the leader opening the topic on behalf of the group; it may briefly evoke the group's purpose, but must not impersonate another member."
      : "This is a private chat between currentBot and the user.",
    JSON.stringify({
      task: "new_topic_greeting",
      variation,
      interface: { language, timeZone, localDateTime },
      currentBot: cleanBot(bot),
      group: group
        ? {
            name: group.name.trim(),
            description: group.description?.trim() || "",
            humanName: group.humanName?.trim() || "user",
            members: group.members.map(cleanBot),
          }
        : undefined,
    }),
  ].join("\n");
}

function cleanBot(bot: GreetingBotProfile) {
  return {
    id: bot.id,
    name: bot.name.trim(),
    description: bot.description?.trim() || "",
    labels: bot.labels?.trim() || "",
  };
}

