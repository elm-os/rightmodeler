import { TicketModel } from "../llm.js";

export async function handleTicket(
  model: TicketModel,
  body: string,
): Promise<string> {
  return model.classify(body);
}
