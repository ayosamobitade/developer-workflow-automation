// import { defineConfig } from "vite";
// import react from "@vitejs/plugin-react";
// import tailwindcss from "@tailwindcss/vite";

// export default defineConfig({
//     plugins: [react(), tailwindcss()],
//     build: {
//         rollupOptions: {
//             input: {
//                 sidepanel: "index.html",
//             },
//         },
//     },
// });

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],

    build: {
        rollupOptions: {
            input: {
                sidepanel: "index.html",
                backgroundCoordinator: "src/background/index.js",
            },

            output: {
                entryFileNames: (chunk) => (
                    chunk.name === "backgroundCoordinator"
                        ? "background-coordinator.js"
                        : "assets/[name]-[hash].js"
                ),

                chunkFileNames: "assets/[name]-[hash].js",
                assetFileNames: "assets/[name]-[hash][extname]",
            },
        },
    },
});