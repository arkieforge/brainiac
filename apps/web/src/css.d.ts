import "react";

// Custom properties in `style`, such as a row's stagger index `--i`, without a cast at each use.
declare module "react" {
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
  }
}
