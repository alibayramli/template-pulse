import { useEffect, useId, useState } from 'react';
import {
  Button,
  ButtonIcon,
  Select,
  Text,
  Tooltip,
  TooltipTrigger,
  type SelectSearch,
} from '@backstage/ui';
import { parseEntityRef } from '@backstage/catalog-model';
import { InfoTooltip } from './InfoTooltip';

export function ClearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 6l12 12M6 18L18 6" />
    </svg>
  );
}

export function ResetIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 5v5h5M4 10a8 8 0 1 1 2 8" />
    </svg>
  );
}

export function entityFilterName(ref: string) {
  try {
    const { namespace, name } = parseEntityRef(ref);
    return namespace === 'default' ? name : `${namespace}/${name}`;
  } catch {
    return ref;
  }
}

export type EntityFilterOption = {
  id: string;
  label: string;
  description?: string;
};

export type EntityFilterSearch = (
  query: string,
  signal: AbortSignal,
) => Promise<{ items: EntityFilterOption[]; hasMore: boolean }>;

export function EntityFilterSelect({
  label,
  labelHelp,
  value,
  options,
  onChange,
  loadOptions,
  hasMore = false,
}: {
  label: string;
  labelHelp?: string;
  value: string;
  options: EntityFilterOption[];
  onChange: (value: string) => void;
  loadOptions?: EntityFilterSearch;
  hasMore?: boolean;
}) {
  const labelId = useId();
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selectedOption, setSelectedOption] = useState<EntityFilterOption>();
  const [remote, setRemote] = useState<{
    source: EntityFilterSearch;
    search: string;
    items: EntityFilterOption[];
    hasMore: boolean;
  }>();
  useEffect(() => setSearch(''), [value, loadOptions]);
  useEffect(() => {
    if (!loadOptions || !search.trim()) {
      setLoading(false);
      setFailed(false);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    const timer = setTimeout(() => {
      loadOptions(search, controller.signal)
        .then(page => {
          if (!controller.signal.aborted)
            setRemote({ source: loadOptions, search, ...page });
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [loadOptions, search, retry]);
  const page =
    remote && remote.source === loadOptions && remote.search === search
      ? remote
      : undefined;
  const knownOptions = new Map(options.map(item => [item.id, item]));
  const retainLabel = (item: EntityFilterOption) => {
    const known = knownOptions.get(item.id);
    if (known && known.label !== known.id) return known;
    if (selectedOption?.id === item.id) return selectedOption;
    return item;
  };
  const visibleOptions = loadOptions
    ? [
        ...new Map(
          [
            ...options.filter(item => item.id === 'any' || item.id === value),
            ...(page?.items ?? (search.trim() ? [] : options)),
          ].map(item => [item.id, retainLabel(item)]),
        ).values(),
      ]
    : options;
  let optionsHint: string | undefined;
  if (loadOptions && !loading && !failed) {
    if (page?.hasMore) optionsHint = 'Refine your search';
    else if (!search.trim() && hasMore)
      optionsHint = 'Type to find more options';
  }
  let searchConfig: SelectSearch<EntityFilterOption> | undefined;
  if (loadOptions) {
    searchConfig = {
      mode: 'server',
      inputValue: search,
      onInputChange: input => setSearch(input.slice(0, 200)),
      placeholder: `Search ${label.toLowerCase()}s…`,
    };
  } else if (options.length > 10) {
    searchConfig = {
      placeholder: `Search ${label.toLowerCase()}s…`,
      filter: (item, query) =>
        `${item.label} ${item.description ?? ''} ${item.id}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    };
  }
  const select = (
    <div
      className="template-pulse-analytics-clearable-select"
      data-active={value !== 'any' || undefined}
    >
      {labelHelp && (
        <div className="template-pulse-analytics-select-label">
          <span id={labelId}>{label}</span>
          <InfoTooltip
            label={`About ${label.toLowerCase()} filter`}
            text={labelHelp}
          />
        </div>
      )}
      <Select
        label={labelHelp ? undefined : label}
        aria-labelledby={labelHelp ? labelId : undefined}
        size="small"
        selectionMode="single"
        value={value}
        options={
          optionsHint
            ? [{ title: optionsHint, options: visibleOptions }]
            : visibleOptions
        }
        loading={
          loadOptions ? { state: loading ? 'filtering' : 'idle' } : undefined
        }
        search={searchConfig}
        onChange={key => {
          const next = String(key ?? 'any');
          if (loadOptions)
            setSelectedOption(visibleOptions.find(item => item.id === next));
          onChange(next);
        }}
      />
      {value !== 'any' && (
        <TooltipTrigger delay={200}>
          <ButtonIcon
            className="template-pulse-analytics-select-clear"
            aria-label={`Clear ${label.toLowerCase()} filter`}
            variant="tertiary"
            size="small"
            icon={<ClearIcon />}
            onPress={() => onChange('any')}
          />
          <Tooltip>Clear {label.toLowerCase()} filter</Tooltip>
        </TooltipTrigger>
      )}
    </div>
  );
  if (!loadOptions) return select;
  return (
    <div>
      {select}
      {(loading || failed) && (
        <div role={failed ? 'alert' : 'status'}>
          <Text variant="body-small" color="secondary">
            {failed ? 'Options could not be loaded. ' : 'Searching…'}
          </Text>
          {failed && (
            <Button
              size="small"
              variant="tertiary"
              onPress={() => setRetry(attempt => attempt + 1)}
            >
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
