import { DatabaseKind } from '@/features/ConnectDBRedesign/types';
import * as RadioGroup from '@radix-ui/react-radio-group';
import clsx from 'clsx';
import React from 'react';

const twRadioStyles = {
  //root: `flex flex-row gap-3 flex-wrap w-full`,
  root: `grid grid-cols-4 gap-3`,
  itemContainer: {
    default: `flex items-center border bg-white shadow-sm rounded border-gray-300 cursor-pointer relative flex-[0_0_160px] h-[88px]`,
    active: `ring-2 ring-blue-300 border-blue-400`,
    disabled: ` cursor-not-allowed bg-gray-200`,
  },
  radioButton: `bg-white w-[20px] h-[20px] rounded-full shadow-eq shadow-blue-900 hover:bg-blue-100 flex-[2] absolute top-0 left-0 m-3`,
  indicator: `flex items-center justify-center w-full h-full relative after:content[''] after:block after:w-[10px] after:h-[10px] after:rounded-[50%] after:bg-blue-600`,
  label: `text-base whitespace-nowrap cursor-pointer flex-[1] h-full w-full flex justify-center items-center`,
};

export const FancyRadioCards: React.VFC<{
  value: string;
  items: {
    value: string;
    content: React.ReactNode | string;
  }[];
  onChange: (value: DatabaseKind) => void;
}> = ({ value, items, onChange }) => {
  return (
    <RadioGroup.Root
      className={twRadioStyles.root}
      defaultValue={value}
      aria-label="View density"
      onValueChange={onChange}
    >
      {items.map((item, i) => {
        return (
          <div
            className={clsx(
              twRadioStyles.itemContainer.default,
              value === item.value && twRadioStyles.itemContainer.active
            )}
          >
            <RadioGroup.Item
              className={twRadioStyles.radioButton}
              value={item.value}
              id={`radio-item-${item.value}`}
            >
              <RadioGroup.Indicator className={twRadioStyles.indicator} />
            </RadioGroup.Item>
            <label
              className={twRadioStyles.label}
              htmlFor={`radio-item-${item.value}`}
            >
              {item.content}
            </label>
          </div>
        );
      })}
    </RadioGroup.Root>
  );
};
