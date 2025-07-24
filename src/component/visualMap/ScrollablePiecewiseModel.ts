import { inheritDefaultOption } from '../../util/component';
import {
    LabelOption,
    ZRColor
} from '../../util/types';
import PiecewiseModel, {
    PiecewiseVisualMapOption
} from './PiecewiseModel';

type SelectorType = 'all' | 'inverse';
export interface VisualMapSelectorButtonOption {
    type?: SelectorType
    title?: string
}

export interface ScrollablePiecewiseVisualMapOption extends PiecewiseVisualMapOption {

    scrollDataIndex?: number;
    /**
     * Gap between each page button
     */
    pageButtonItemGap?: number;
    /**
     * Gap between page buttons group and legend items.
     */
    pageButtonGap?: number;
    pageButtonPosition?: 'start' | 'end';
    pageFormatter?: string | ((param: {
        current: number;
        total: number;
    }) => string);
    pageIcons?: {
        horizontal?: string[];
        vertical?: string[];
    };
    pageIconColor?: ZRColor;
    pageIconInactiveColor?: ZRColor;
    pageIconSize?: number;
    pageTextStyle?: LabelOption;
    /**
     * If enable animation
     */
    animation?: boolean;
    animationDurationUpdate?: number;
}

class ScrollablePiecewiseModel extends PiecewiseModel<ScrollablePiecewiseVisualMapOption> {

    static type = 'visualMap.scrollPiecewise' as const;
    type = ScrollablePiecewiseModel.type;

    /**
     * @param {number} scrollDataIndex
     */
    setScrollDataIndex(scrollDataIndex: number) {
        this.option.scrollDataIndex = scrollDataIndex;
    }

    static defaultOption = inheritDefaultOption(PiecewiseModel.defaultOption, {
        scrollDataIndex: 0,
        pageButtonItemGap: 5,
        pageButtonGap: null,
        pageButtonPosition: 'end', // 'start' or 'end'
        pageFormatter: '{current}/{total}', // If null/undefined, do not show page.
        pageIcons: {
            horizontal: ['M0,0L12,-10L12,10z', 'M0,0L-12,-10L-12,10z'],
            vertical: ['M0,0L20,0L10,-20z', 'M0,0L20,0L10,20z']
        },
        pageIconColor: '#2f4554',
        pageIconInactiveColor: '#aaa',
        pageIconSize: 15, // Can be [10, 3], which represents [width, height]
        pageTextStyle: {
            color: '#333'
        },

        animationDurationUpdate: 800
    }) as ScrollablePiecewiseVisualMapOption;
}

export default ScrollablePiecewiseModel;