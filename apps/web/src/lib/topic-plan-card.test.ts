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

const confirmArgs = {
  goal: 'Learn Kubernetes',
  level: 'beginner',
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
};

test('confirm arguments become plan rows', () => {
  expect(topicPlanCardRows(confirmArgs as unknown as string)).toEqual([
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

test('a module that still needs pages stays marked on the card', () => {
  const marked = JSON.stringify({
    modules: [
      {
        title: 'Ownership',
        outcome: 'Explain who owns a value.',
        urls: [],
        needsPages: true,
      },
      {
        title: 'Services',
        outcome: 'Expose a set of pods.',
        urls: [],
      },
    ],
  });
  expect(topicPlanCardRows(marked)).toEqual([
    {
      title: 'Ownership',
      outcome: 'Explain who owns a value.',
      urls: [],
      needsPages: true,
    },
    {
      title: 'Services',
      outcome: 'Expose a set of pods.',
      urls: [],
    },
  ]);
});

test('create_topic_plan label shows the goal', () => {
  const label = toolLabel('create_topic_plan', { goal: 'Learn Kubernetes' });
  expect(label.labelKey).toBe('chat.tool.create_topic_plan');
  expect(label.argMono).toBe('Learn Kubernetes');
});
