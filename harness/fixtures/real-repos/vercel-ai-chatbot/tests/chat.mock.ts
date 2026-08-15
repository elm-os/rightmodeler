import { vi } from "vitest";

const example = "streamText({ model: 'not-a-call', messages: [] })";

// embedMany({ model: "not-a-call", values: [] });
vi.mock("ai", () => ({
  streamText: vi.fn(),
  tool: vi.fn(),
}));

export const mockDescription = example;
