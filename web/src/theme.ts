import { createTheme, type MantineColorsTuple } from '@mantine/core';

/** 무채색 기본. 색은 상태(환경 타입, ERROR)에만 쓴다. */
const slate: MantineColorsTuple = [
  '#f4f5f7',
  '#e6e8eb',
  '#cbcfd5',
  '#aeb4bd',
  '#959daa',
  '#858e9d',
  '#7c8798',
  '#6a7485',
  '#5d6777',
  '#4e5969',
];

export const theme = createTheme({
  fontFamily: 'Pretendard Variable, Pretendard, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  fontFamilyMonospace: 'JetBrains Mono, D2Coding, Menlo, monospace',
  headings: { fontFamily: 'Pretendard Variable, Pretendard, sans-serif', fontWeight: '600' },
  defaultRadius: 'sm',
  primaryColor: 'slate',
  colors: { slate },
  components: {
    Button: { defaultProps: { size: 'sm' } },
    Table: { defaultProps: { striped: false, highlightOnHover: true } },
  },
});

/** 환경 타입 색. prod 만 붉은 계열로 눈에 박히게 둔다. */
export const ENV_COLOR: Record<string, string> = {
  dev: 'gray',
  rde: 'gray',
  stage: 'blue',
  prod: 'red',
};
