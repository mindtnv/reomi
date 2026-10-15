export type SetDueStateGroup = 'new' | 'learning' | 'review';

const ORDER: readonly SetDueStateGroup[] = ['new', 'learning', 'review'];

export function setDueStateGroups(states: readonly string[]): SetDueStateGroup[] {
  const present = new Set<SetDueStateGroup>();
  for (const state of states) {
    if (state === 'new') present.add('new');
    else if (state === 'learning' || state === 'relearning') present.add('learning');
    else if (state === 'review') present.add('review');
  }
  return ORDER.filter((group) => present.has(group));
}
