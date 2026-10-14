import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { parseModel } from "./analyze-mesh.js";
import { suggestOrientation } from "../orientation.js";

export function registerSuggestOrientation(server: McpServer) {
  server.registerTool(
    "suggest_orientation",
    {
      title: "Suggérer la meilleure orientation d'impression",
      description:
        "Teste 6 orientations principales d'un modèle 3D et classe chacune " +
        "selon les overhangs, la hauteur d'impression, le contact plateau, et le volume de supports. " +
        "Retourne un classement avec le score et l'explication pour chaque orientation.",
      inputSchema: {
        file_path: z.string().describe("Chemin absolu vers le fichier STL ou 3MF"),
      },
    },
    async ({ file_path }) => {
      try {
        if (!existsSync(file_path)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Fichier non trouvé : ${file_path}` }],
          };
        }

        console.error(`[suggest_orientation] Analyzing orientations for ${file_path}...`);
        const mesh = await parseModel(file_path);
        const results = suggestOrientation(mesh);

        const lines: string[] = [
          `## Orientations d'impression — classement`,
          "",
        ];

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const medal = i === 0 ? " **RECOMMANDÉ**" : "";
          lines.push(`### ${i + 1}. ${r.name}${medal}`);
          lines.push(`- **Score** : ${r.score}/100`);
          lines.push(`- **Overhangs** : ${r.overhangPercent.toFixed(1)}% (${r.overhangArea.toFixed(0)}mm²)`);
          lines.push(`- **Hauteur** : ${r.printHeight.toFixed(1)}mm`);
          lines.push(`- **Contact plateau** : ${r.bedContact.toFixed(1)}mm²`);
          lines.push(`- **Supports estimés** : ${r.supportVolume.toFixed(0)}mm³`);
          if (r.rotation.axisX !== 0 || r.rotation.axisY !== 0) {
            lines.push(`- **Rotation** : X=${r.rotation.axisX}° Y=${r.rotation.axisY}°`);
          }
          lines.push(`- _${r.reasoning}_`);
          lines.push("");
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `Erreur : ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    },
  );
}
