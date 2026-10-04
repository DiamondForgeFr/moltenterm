// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import clsx from "clsx";
import { forwardRef, memo, ReactNode, useImperativeHandle, useRef } from "react";

import { moltenButtonClasses, MoltenWave } from "../../moltenterm-shell/molten-button"; // MOLTENTERM-PATCH (#145)
import "./button.scss";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    className?: string;
    children?: ReactNode;
    as?: keyof React.JSX.IntrinsicElements | React.ComponentType<any>;
}

const Button = memo(
    forwardRef<HTMLButtonElement, ButtonProps>(
        ({ children, disabled, className = "", as: Component = "button", ...props }: ButtonProps, ref) => {
            const btnRef = useRef<HTMLButtonElement>(null);
            useImperativeHandle(ref, () => btnRef.current as HTMLButtonElement);

            // MOLTENTERM-PATCH (#145): the default and green buttons are molten call-to-action buttons, the other
            // colours map to destructive, warning and calm variants; Wave's green class no longer reaches the DOM.
            const molten = moltenButtonClasses(className);

            return (
                <Component
                    ref={btnRef}
                    tabIndex={disabled ? -1 : 0}
                    className={clsx("wave-button", molten.className)}
                    disabled={disabled}
                    {...props}
                >
                    {molten.wave && typeof Component === "string" ? (
                        <>
                            {children}
                            <MoltenWave />
                        </>
                    ) : (
                        children
                    )}
                </Component>
            );
        }
    )
);

Button.displayName = "Button";

export { Button };
