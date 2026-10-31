import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('FigmaBottomTabBar Logic & Layout Contract', () => {
  function computeTabBarLayout(routes, centerAction) {
    if (!centerAction) {
      return { left: routes, center: null, right: [] };
    }
    const half = Math.ceil(routes.length / 2);
    return {
      left: routes.slice(0, half),
      center: centerAction,
      right: routes.slice(half),
    };
  }

  test('splits tabs around center action for 4 tabs', () => {
    const routes = [
      { name: 'index', key: 'k1' },
      { name: 'classes', key: 'k2' },
      { name: 'reports', key: 'k3' },
      { name: 'profile', key: 'k4' },
    ];
    const center = { label: 'Attendance' };
    const layout = computeTabBarLayout(routes, center);

    assert.equal(layout.left.length, 2);
    assert.equal(layout.left[0].name, 'index');
    assert.equal(layout.left[1].name, 'classes');
    assert.equal(layout.center.label, 'Attendance');
    assert.equal(layout.right.length, 2);
    assert.equal(layout.right[0].name, 'reports');
    assert.equal(layout.right[1].name, 'profile');
  });

  test('renders all tabs directly when no center action is provided', () => {
    const routes = [
      { name: 'index', key: 'k1' },
      { name: 'attendance', key: 'k2' },
      { name: 'requests', key: 'k3' },
      { name: 'profile', key: 'k4' },
    ];
    const layout = computeTabBarLayout(routes, null);

    assert.equal(layout.left.length, 4);
    assert.equal(layout.center, null);
    assert.equal(layout.right.length, 0);
  });

  test('tab navigation event handler calls navigate only when unfocused', () => {
    let navigatedTo = null;
    let emittedEvent = null;

    const mockNavigation = {
      emit: (ev) => {
        emittedEvent = ev;
        return { defaultPrevented: false };
      },
      navigate: (name) => {
        navigatedTo = name;
      },
    };

    function handlePress({ isFocused, routeName, routeKey }) {
      const event = mockNavigation.emit({
        type: 'tabPress',
        target: routeKey,
        canPreventDefault: true,
      });

      if (!isFocused && !event.defaultPrevented) {
        mockNavigation.navigate(routeName);
      }
    }

    // 1. Unfocused press navigates
    handlePress({ isFocused: false, routeName: 'reports', routeKey: 'k3' });
    assert.equal(emittedEvent.target, 'k3');
    assert.equal(navigatedTo, 'reports');

    // 2. Focused press emits tabPress but does not navigate
    navigatedTo = null;
    handlePress({ isFocused: true, routeName: 'reports', routeKey: 'k3' });
    assert.equal(navigatedTo, null);
  });
});
