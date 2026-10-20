import type { AiThinkingCapabilities } from "@tap/shared";

type Definition = { defaultId: string; options: Array<{id:string; label:string; description:string; value:string|number}>; parameter: "level" | "budget" };
const levels = [
  {id:"minimal",label:"最小",description:"思考を最小限にして速く生成",value:"minimal"},
  {id:"low",label:"低",description:"速度を優先して生成",value:"low"},
  {id:"medium",label:"標準",description:"品質と待ち時間のバランス",value:"medium"},
  {id:"high",label:"高",description:"深く考えて生成。時間がかかる場合があります",value:"high"},
];
/** Audited against Google GenerateContent thinking docs. No model-name guessing.
 * models.get exposes thinking:boolean but not valid levels; keep versioned definitions here.
 * Add provider-specific wire conversion here when enabling another provider/model.
 */
const definitions: Record<string, Definition> = {
  "gemini:gemini-3.5-flash-lite": {parameter:"level",defaultId:"medium",options:levels},
  "gemini:gemini-3.8-flash": {parameter:"level",defaultId:"medium",options:levels.filter(option => option.id !== "minimal")},
  "gemini:gemini-2.5-flash": {parameter:"budget",defaultId:"auto",options:[
    {id:"auto",label:"自動",description:"モデルが思考量を調整",value:-1},
    {id:"off",label:"なし",description:"思考を無効にする",value:0},
    {id:"budget-8192",label:"8,192トークン",description:"思考に使うトークン予算",value:8192},
    {id:"budget-24576",label:"24,576トークン",description:"より多くの思考予算",value:24576},
  ]},
};
export function thinkingCapabilities(provider:string, model:string):AiThinkingCapabilities {
  const def=definitions[`${provider}:${model}`];
  return {provider,model,version:"2026-09-09",supported:Boolean(def),defaultId:def?.defaultId ?? "default",
    options:def?.options.map(({id,label,description})=>({id,label,description})) ?? []};
}
export function thinkingConfig(provider:string, model:string, selected?:string):Record<string,unknown> {
  const def=definitions[`${provider}:${model}`];
  if (!def) {
    if (selected && selected!=="default") throw new Error("このモデルでは選択した思考量を利用できません。ページを再読み込みしてください。");
    return {};
  }
  const choice=def.options.find(o=>o.id===(selected ?? def.defaultId));
  if(!choice) throw new Error("このモデルでは選択した思考量を利用できません。ページを再読み込みしてください。");
  return {thinkingConfig:{[def.parameter==="level"?"thinkingLevel":"thinkingBudget"]:choice.value}};
}
