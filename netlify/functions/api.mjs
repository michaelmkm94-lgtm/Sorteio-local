// Ponto de entrada da função do Netlify: liga a lógica (lib/app.mjs) ao Netlify Blobs.
import { getStore } from "@netlify/blobs";
import { createApp } from "./lib/app.mjs";

let handler;

export default async (req, context) => {
  if (!handler) {
    handler = createApp({
      // "strong": leituras sempre enxergam a última gravação (essencial para cadastro e sorteio)
      store: getStore({ name: "sorteio", consistency: "strong" }),
      adminPassword: process.env.ADMIN_PASSWORD || "",
    });
  }
  return handler(req, context?.ip || req.headers.get("x-nf-client-connection-ip") || "");
};

export const config = { path: "/api/*" };
