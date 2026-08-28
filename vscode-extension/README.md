# React Component Preview

Расширение для VS Code, которое показывает React-компоненты прямо из `.jsx` и `.tsx`-файлов. Превью описывается рядом с компонентом, а расширение собирает выбранный экспорт и открывает его в отдельной панели.

## Быстрый старт

1. В каталоге `vscode-extension` установите зафиксированные зависимости: `npm ci`.
2. Откройте корень репозитория в VS Code и нажмите `F5`.
3. В проекте React откройте `.tsx` или `.jsx` файл.
4. Добавьте директиву превью рядом с экспортом компонента.
5. Нажмите `Preview: <название>` над директивой или выполните команду `React Preview: Open Preview`.

Пример:

```tsx
export function Button({ label, disabled = false }) {
  return <button disabled={disabled}>{label}</button>;
}

// #preview "Primary" Button {"label":"Continue"}
// #preview "Disabled" Button {"label":"Continue","disabled":true}
```

Для сложного состояния можно использовать JSX-body:

```tsx
// #preview("Nested") { <Button><strong>Continue</strong></Button> }
```

Для одной комплексной демонстрации используйте отдельный preview-модуль. Он собирается только расширением и не меняет обычный код приложения:

```tsx
/* #preview-module("Button gallery")
const demos = [
  <Button label="Primary" />,
  <Button label="Disabled" disabled />,
];

return <div className="grid gap-4">{demos}</div>;
*/
```

Подробное описание синтаксиса находится в файле `docs/preview.md`.
