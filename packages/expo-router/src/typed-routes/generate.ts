import { RouteNode } from '../Route';
import { getRoutes } from '../getRoutes';
import { removeSupportedExtensions } from '../matchers';
import { RequireContext } from '../types';

// /[...param1]/ - Match [...param1]
const CATCH_ALL = /\[\.\.\..+?\]/g;
// /[param1] - Match [param1]
const SLUG = /\[.+?\]/g;
// /(group)/path/(group2)/route - Match [(group), (group2)]
const GROUP = /(?:^|\/)\(.*?\)/g;

const urlParams = "${`?${string}` | `#${string}` | ''}";

export type GetTypedRoutesDeclarationFileOptions = {
  partialTypedGroups?: boolean;
  testIgnoreComments?: boolean;
};

export function getTypedRoutesDeclarationFile(
  ctx: RequireContext,
  {
    partialTypedGroups = false,
    testIgnoreComments = false,
  }: GetTypedRoutesDeclarationFileOptions = {}
) {
  let routeNode: RouteNode | null = null;

  try {
    routeNode = getRoutes(ctx, {
      ignore: [/_layout\.[tj]sx?$/], // Skip layout files
      platformRoutes: false, // We don't need to generate platform specific routes
      notFound: false, // We don't need +not-found routes either
      ignoreEntryPoints: true,
      ignoreRequireErrors: true,
      importMode: 'async', // Don't load the file
    });
  } catch {
    // Ignore errors from `getRoutes`. This is also called inside the app, which has
    // a nicer UX for showing error messages
  }

  const groupedNodes = groupRouteNodes(routeNode);
  const staticRoutesStrings: string[] = ['Router.RelativePathString', 'Router.ExternalPathString'];
  const staticRouteInputObjects: string[] = [
    '{ pathname: Router.RelativePathString, params?: Router.UnknownInputParams }',
    '{ pathname: Router.ExternalPathString, params?: Router.UnknownInputParams }',
  ];
  const staticRouteOutputObjects: string[] = [
    '{ pathname: Router.RelativePathString, params?: Router.UnknownOutputParams }',
    '{ pathname: Router.ExternalPathString, params?: Router.UnknownOutputParams }',
  ];

  for (const type of groupedNodes.static) {
    staticRoutesStrings.push(contextKeyToType(type + urlParams, partialTypedGroups));
    staticRouteInputObjects.push(
      `{ pathname: ${contextKeyToType(type, partialTypedGroups)}; params?: Router.UnknownInputParams; }`
    );
    staticRouteOutputObjects.push(
      `{ pathname: ${contextKeyToType(type, partialTypedGroups)}; params?: Router.UnknownOutputParams; }`
    );
  }

  const dynamicRouteStrings: string[] = [];
  const dynamicRouteInputObjects: string[] = [];
  const dynamicRouteOutputObjects: string[] = [];

  for (const [dynamicRouteTemplate, paramsNames] of groupedNodes.dynamic) {
    const inputParams = paramsNames
      .map((param) => {
        const key = param.startsWith('...') ? param.slice(3) : param;
        const value = param.startsWith('...') ? '(string | number)[]' : 'string | number';
        return `${key}: ${value};`;
      })
      .join('');

    const outputParams = paramsNames
      .map((param) => {
        const key = param.startsWith('...') ? param.slice(3) : param;
        const value = param.startsWith('...') ? 'string[]' : 'string';
        return `${key}: ${value};`;
      })
      .join('');

    dynamicRouteStrings.push(
      contextKeyToType(
        dynamicRouteTemplate
          .replaceAll(CATCH_ALL, '${string}')
          .replaceAll(SLUG, '${Router.SingleRoutePart<T>}'),
        partialTypedGroups
      )
    );

    dynamicRouteInputObjects.push(
      `{ pathname: ${contextKeyToType(dynamicRouteTemplate, partialTypedGroups)}, params: Router.UnknownInputParams & { ${inputParams} } }`
    );
    dynamicRouteOutputObjects.push(
      `{ pathname: ${contextKeyToType(dynamicRouteTemplate, partialTypedGroups)}, params: Router.UnknownOutputParams & { ${outputParams} } }`
    );
  }

  const href = [
    ...staticRoutesStrings,
    ...staticRouteInputObjects,
    ...dynamicRouteStrings,
    ...dynamicRouteInputObjects,
  ].join(' | ');

  const hrefInputParams = [...staticRouteInputObjects, ...dynamicRouteInputObjects].join(' | ');
  const hrefOutputParams = [...staticRouteOutputObjects, ...dynamicRouteOutputObjects].join(' | ');

  const tsExpectError = testIgnoreComments
    ? '// @ts-ignore-error -- During tests we need to ignore the "duplicate" declaration error, as multiple fixture declare types \n      '
    : '';

  return `/* eslint-disable */
import * as Router from 'expo-router';

export * from 'expo-router';

declare module 'expo-router' {
  export namespace ExpoRouter {
    export interface __routes<T extends string | object = string> {
      ${tsExpectError}hrefInputParams: ${hrefInputParams};
      ${tsExpectError}hrefOutputParams: ${hrefOutputParams};
      ${tsExpectError}href: ${href};
    }
  }
}
`;
}

function groupRouteNodes(
  routeNode: RouteNode | null,
  groupedContextKeys = {
    static: new Set<string>(),
    dynamic: new Map<string, string[]>(),
  }
) {
  if (!routeNode) {
    return groupedContextKeys;
  }

  // Skip non-route files
  if (routeNode.type !== 'route') {
    // Except the root layout
    if (routeNode.route === '') {
      for (const child of routeNode.children) {
        groupRouteNodes(child, groupedContextKeys);
      }
      return groupedContextKeys;
    }

    return groupedContextKeys;
  }

  let routeKey: string;

  if (routeNode.generated) {
    // Some routes like the root _layout, _sitemap, +not-found are generated.
    // We cannot use the contextKey, as their context key does not specify a route
    routeKey = routeNode.route;
  } else {
    routeKey = removeSupportedExtensions(routeNode.contextKey)
      .replace(/\/index$/, '') // Remove any trailing /index
      .replace(/^\./, ''); // Remove any leading .
  }

  routeKey ||= '/'; // A routeKey may be empty for contextKey '' or './index.js'

  if (!routeKey.startsWith('/')) {
    // Not all generated files will have the `/` prefix
    routeKey = `/${routeKey}`;
  }

  routeKey = routeKey.replace(/\\/g, '/');

  if (routeNode.dynamic) {
    groupedContextKeys.dynamic.set(
      routeKey,
      routeKey
        .split('/')
        .filter((segment) => {
          return segment.startsWith('[') && segment.endsWith(']');
        })
        .map((segment) => {
          return segment.slice(1, -1);
        })
    );
  } else {
    groupedContextKeys.static.add(routeKey);
  }

  for (const child of routeNode.children) {
    groupRouteNodes(child, groupedContextKeys);
  }

  return groupedContextKeys;
}

function contextKeyToType(contextKey: string, partialTypedGroups: boolean) {
  if (contextKey.match(GROUP) === null) {
    return `\`${contextKey}\``;
  }

  // If the route has groups, turn them into template strings
  const typeWithGroups = contextKey.replaceAll(GROUP, (match) => {
    const groups = match.slice(2, -1); // Remove the leading ( and the trailing )
    // When `partialRoutes` is enabled, we always change a group to a template
    if (groups.length > 1 || partialTypedGroups) {
      // Ensure each group has the trailing slash
      const groupsAsType = groups.split(',').map((group) => `'/(${group})'`);
      // `partialRoutes` allow you to skip a group
      if (partialTypedGroups) {
        groupsAsType.push("''");
      }
      // Combine together into a union
      return `\${${groupsAsType.join(' | ')}}`;
    } else {
      return match;
    }
  });

  let typeWithoutGroups = contextKey.replaceAll(GROUP, '') || '/';

  /**
   * When getting the static routes, they include a urlParams string at the end.
   * If we have a route like `/(group)/(group2)`, this would normally be collapsed to `/`.
   * But because of the urlParams, it becomes `${urlParams}` and we need to add a `/` to the start.
   */
  if (typeWithoutGroups.startsWith(urlParams)) {
    typeWithoutGroups = `/${typeWithoutGroups}`;
  }

  return `\`${typeWithGroups}\` | \`${typeWithoutGroups}\``;
}
