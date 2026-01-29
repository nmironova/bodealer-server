module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce API property descriptions to end with a period',
      category: 'Best Practices',
      recommended: true,
    },
    fixable: 'code',
    schema: [],
  },
  create(context) {
    return {
      Decorator(node) {
        // Check if this is an ApiProperty or ApiPropertyOptional decorator
        const decoratorName = node.expression?.callee?.name;
        if (decoratorName !== 'ApiProperty' && decoratorName !== 'ApiPropertyOptional') {
          return;
        }

        // Find the property name from the parent node (class property)
        let propertyName = 'unknown';
        if (node.parent && node.parent.key && node.parent.key.name) {
          propertyName = node.parent.key.name;
        }

        // Find the description property in the decorator options
        const decoratorOptions = node.expression.arguments[0];
        if (!decoratorOptions || decoratorOptions.type !== 'ObjectExpression') {
          return;
        }

        const descriptionProperty = decoratorOptions.properties.find(
          (prop) => prop.key.name === 'description',
        );

        // Check if description exists
        if (!descriptionProperty) {
          return;
        }

        // Check if description ends with a period
        // if `eslint --fix`, then it append a dot.
        if (descriptionProperty.value.type === 'Literal') {
          const description = descriptionProperty.value.value;
          if (typeof description === 'string' && description !== description.trim()) {
            context.report({
              node,
              message: `${decoratorName} '${propertyName}' should not have leading or trailing whitespace`,
              fix(fixer) {
                return fixer.replaceText(descriptionProperty.value, `'${description.trim()}'`);
              },
            });
          }

          if (typeof description === 'string' && !description.endsWith('.')) {
            context.report({
              node: descriptionProperty.value,
              message: `${decoratorName} '${propertyName}' description should end with a period`,
              fix(fixer) {
                return fixer.replaceText(
                  descriptionProperty.value,
                  `'${description.replace(/['\\]/g, '\\$&')}.'`,
                );
              },
            });
          }
        }
      },
    };
  },
};
