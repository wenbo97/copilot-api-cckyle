import config from "@echristian/eslint-config"

export default config({
  ignores: [
    "node_modules/**",
    "dist/**",
    "build/**",
    "coverage/**",
    "**/*.min.js",
  ],
  prettier: {
    plugins: ["prettier-plugin-packagejson"],
  },
})
