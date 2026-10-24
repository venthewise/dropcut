import "./styles.css";
import { REPO_URL } from "./config";
import { startHero } from "./hero";
import { mountTool } from "./tool";

const repo = document.querySelector<HTMLAnchorElement>("#repo-link");
if (repo) {
  repo.href = REPO_URL;
  repo.target = "_blank";
  repo.rel = "noopener noreferrer";
}

startHero();

const toolRoot = document.querySelector<HTMLElement>("#tool-root");
if (toolRoot) mountTool(toolRoot);
