import { useState, type FormEvent } from 'react';
import { TRAIN_COPY } from '../../training/copy';

interface Props {
  /** Returns false when the link is not acceptable. */
  onLink: (url: string) => boolean;
}

/** Paste-a-link form, for the installed app where tapping a coach link opens the browser instead. */
export function CoachLinkForm({ onLink }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(onLink(value) ? null : TRAIN_COPY.badLink);
  };

  return (
    <form className="coach-link-form" onSubmit={submit}>
      <label htmlFor="coach-link">{TRAIN_COPY.pasteLink}</label>
      <input
        id="coach-link"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        inputMode="url"
        autoComplete="off"
        placeholder="https://"
      />
      <button type="submit" className="secondary-button">
        {TRAIN_COPY.linkButton}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
