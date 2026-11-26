import { useEffect, useRef, useState } from 'react';
import { ButtonIcon, Tooltip, TooltipTrigger } from '@backstage/ui';

export function InfoTooltip({ label, text }: { label: string; text: string }) {
  const [isOpen, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const dismissOnOutsidePress = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !buttonRef.current?.contains(event.target) &&
        !tooltipRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', dismissOnOutsidePress, true);
    return () =>
      document.removeEventListener('pointerdown', dismissOnOutsidePress, true);
  }, [isOpen]);

  return (
    <TooltipTrigger
      delay={200}
      isOpen={isOpen}
      onOpenChange={setOpen}
      shouldCloseOnPress={false}
    >
      <ButtonIcon
        ref={buttonRef}
        className="template-pulse-analytics-info"
        size="small"
        variant="tertiary"
        aria-label={label}
        icon={<span aria-hidden="true">ⓘ</span>}
        onPress={() => setOpen(open => !open)}
      />
      <Tooltip ref={tooltipRef}>{text}</Tooltip>
    </TooltipTrigger>
  );
}
