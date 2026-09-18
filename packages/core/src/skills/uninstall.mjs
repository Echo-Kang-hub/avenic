import { removeEmptyDirectory } from "../util/fs.mjs";
import { readDirectState, removeDirectSkills } from "./direct.mjs";
import {
  previousManagedState,
  removeAllManagedSkills,
  removeInstallationFiles,
  removeSkillDirectories,
} from "./install.mjs";
import { stateRoot } from "./paths.mjs";

export async function directSkillNames(context) {
  return (await readDirectState(context)).directSources.flatMap((source) => source.skills);
}

// 无参卸载：把这份安装管的 Skill 全部清掉。直装的先走——先摘记录再删目录，
// 目录删不掉就不能算删掉；然后清托管集、安装文件，全局域再收掉空的 state 目录。
// 管道直删与交互确认两条 CLI 路径只差展示，顺序与边界只在这里写一份。
export async function removeAllInstalledSkills(context, io = console) {
  const directNames = await directSkillNames(context);
  if (directNames.length > 0) {
    await removeDirectSkills(context, directNames);
    await removeSkillDirectories(context, directNames, io);
  }
  const managed = await removeAllManagedSkills(context, await previousManagedState(context), io);
  await removeInstallationFiles(context);
  if (context.global) {
    await removeEmptyDirectory(stateRoot(context.environment));
  }
  return { direct: directNames.length, managed };
}
