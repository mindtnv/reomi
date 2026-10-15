import { expect, test } from 'bun:test';
import { toolLabel } from './chat-activity';
import { topicPlanCardRows } from './topic-plan-card';

const proposal = JSON.stringify({
  goal: 'Learn Kubernetes',
  level: null,
  modules: [
    {
      title: 'Pods',
      outcome: 'Run a container on a node.',
      prerequisiteIndexes: [],
      urls: ['https://kubernetes.io/docs/concepts/workloads/pods/'],
    },
    {
      title: 'Services',
      outcome: 'Expose a set of pods.',
      prerequisiteIndexes: [0],
      urls: [],
    },
  ],
});

test('a proposal tool result becomes plan rows', () => {
  expect(topicPlanCardRows(proposal)).toEqual([
    {
      title: 'Pods',
      outcome: 'Run a container on a node.',
      urls: ['https://kubernetes.io/docs/concepts/workloads/pods/'],
    },
    {
      title: 'Services',
      outcome: 'Expose a set of pods.',
      urls: [],
    },
  ]);
});

test('plain tool text does not become plan rows', () => {
  expect(topicPlanCardRows('No matching cards were found.')).toBeNull();
});

test('propose_topic_plan label shows the goal', () => {
  const label = toolLabel('propose_topic_plan', { goal: 'Learn Kubernetes' });
  expect(label.labelKey).toBe('chat.tool.propose_topic_plan');
  expect(label.argMono).toBe('Learn Kubernetes');
});
