type Props = { label: string };

export function Button({ label }: Props) {
  return <button type="button">{label}</button>;
}
