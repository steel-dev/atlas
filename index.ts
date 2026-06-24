import { Atlas } from "./src";
import { anthropic } from "@ai-sdk/anthropic";
import dotenv from "dotenv";

dotenv.config();

const atlas = new Atlas({ model: anthropic("claude-opus-4-8") });
const { report } = await atlas.research(
  "What's changing in browser automation for AI agents?",
);

console.log(report);
