export interface AgentDependencies<Observation, Action, Result> {
  observe(input: string): Promise<Observation>;
  plan(observation: Observation): Promise<Action>;
  act(action: Action): Promise<Result>;
}

export interface AgentRun<Observation, Action, Result> {
  observation: Observation;
  action: Action;
  result: Result;
}

export async function runAgent<Observation, Action, Result>(
  input: string,
  dependencies: AgentDependencies<Observation, Action, Result>,
): Promise<AgentRun<Observation, Action, Result>> {
  const observation = await dependencies.observe(input);
  const action = await dependencies.plan(observation);
  const result = await dependencies.act(action);
  return { observation, action, result };
}
