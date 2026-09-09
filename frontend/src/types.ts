export interface Entry {
 id: string; name: string; enabled: boolean;
 command?: string; args?: string[]; env?: Record<string,string>; delivery?: 'stdin'|'argv'; output?: 'stdout'|'file';
 path?: string; prompt?: string; color?: string;
}
export interface Config {
 version: number; url: string; token?: string; hasToken: boolean; prompt: string; dryRun: boolean; posting: 'mixed'|'thread'|'reply';
 schedule: {mode:'fixed'|'random';interval:number;min:number;max:number;timeout:number};
 selection: {agent:string;space:string;personality:string}; agents: Entry[]; spaces: Entry[]; personalities: Entry[];
}
export interface Run {
 id:string;startedAt:number;endedAt?:number;status:string;agent:string;space:string;path:string;personality:string;color:string;dryRun:boolean;log:string;text:string;error:string;thread?:number;postId?:number;postUrl?:string;
}
export interface State {
 config:Config;active:boolean;nextAt:number;running:string;runs:Run[];session:string;
 availability:Record<'agents'|'spaces',Record<string,boolean>>;presets:Record<string,Entry>;
}
export interface Backend {
 State():Promise<State>;Save(config:Config):Promise<State>;Start():Promise<void>;Stop():Promise<void>;Launch():Promise<void>;TestBoard():Promise<string>;OpenPost(id:string):Promise<void>;
}
declare global {interface Window {go:{main:{App:Backend}}}}
export type Group = 'agents'|'spaces'|'personalities';
