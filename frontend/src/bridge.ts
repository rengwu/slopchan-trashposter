import type { Config, State } from './types';
export const getState = (): Promise<State> => window.go.main.App.State();
export async function api(path: string, body?: Config): Promise<Partial<State> & { message?: string }> {
 const app = window.go.main.App;
 switch(path) {
  case 'config': if (!body) throw new Error('Missing patch'); return app.Save(body);
  case 'start': await app.Start(); return {};
  case 'stop': await app.Stop(); return {};
  case 'launch': await app.Launch(); return {};
  case 'test': return {message:await app.TestBoard()};
  default: throw new Error(`Unknown action: ${path}`);
 }
}
export const openPost = (id: string) => window.go.main.App.OpenPost(id);
