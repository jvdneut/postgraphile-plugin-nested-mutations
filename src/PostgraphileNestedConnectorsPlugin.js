const inflectionHook = (inflection, build) =>
	build.extend(inflection, {
		nestedConnectByNodeIdField() {
			return this.camelCase(`connect_by_${build.nodeIdFieldName}`);
		},
		nestedConnectByKeyField(options) {
			const { constraint } = options;
			return this.camelCase(
				`connect_by_${constraint.keyAttributes.map(k => k.name).join('_and_')}`,
			);
		},
		nestedConnectByNodeIdInputType(options) {
			const { table } = options;

			const tableFieldName = inflection.tableFieldName(table);

			return this.upperCamelCase(`${tableFieldName}_node_id_connect`);
		},
		nestedConnectByKeyInputType(options) {
			const {
				table,
				constraint: {
					name,
					tags: { name: tagName },
				},
			} = options;

			const tableFieldName = this.tableFieldName(table);

			return this.upperCamelCase(
				`${tableFieldName}_${tagName || name}_connect`,
			);
		},
	});

const pgNestedTableConnect = build => {
	const {
		inflection,
		pgSql: sql,
		gql2pg,
		nodeIdFieldName,
		pgGetGqlTypeByTypeIdAndModifier,
	} = build;

	return async ({
		nestedField,
		connectorField,
		input,
		pgClient,
		parentRow,
	}) => {
		const { foreignTable, keys, foreignKeys } = nestedField;
		const { isNodeIdConnector, constraint } = connectorField;

		const ForeignTableType = pgGetGqlTypeByTypeIdAndModifier(
			foreignTable.type.id,
			null,
		);
		let where = '';

		console.log({ isNodeIdConnector });

		if (isNodeIdConnector) {
			const nodeId = input[nodeIdFieldName];
			const primaryKeys = foreignTable.primaryKeyConstraint.keyAttributes;
			const { Type, identifiers } = build.getTypeAndIdentifiersFromNodeId(
				nodeId,
			);
			if (Type !== ForeignTableType) {
				throw new Error('Mismatched type');
			}
			if (identifiers.length !== primaryKeys.length) {
				throw new Error('Invalid ID');
			}
			where = sql.fragment`${sql.join(
				primaryKeys.map(
					(key, idx) =>
						sql.fragment`${sql.identifier(key.name)} = ${gql2pg(
							identifiers[idx],
							key.type,
							key.typeModifier,
						)}`,
				),
				') and (',
			)}`;
		} else {
			const foreignPrimaryKeys = constraint.keyAttributes;
			where = sql.fragment`${sql.join(
				foreignPrimaryKeys.map(
					k => sql.fragment`
                ${sql.identifier(k.name)} = ${gql2pg(
						input[inflection.column(k)],
						k.type,
						k.typeModifier,
					)}
              `,
				),
				') and (',
			)}`;
		}
		const select = foreignKeys.map(k => sql.identifier(k.name));
		const query = parentRow
			? sql.query`
            update ${sql.identifier(
							foreignTable.namespace.name,
							foreignTable.name,
						)}
            set ${sql.join(
							keys.map(
								(k, i) =>
									sql.fragment`${sql.identifier(k.name)} = ${sql.value(
										parentRow[foreignKeys[i].name],
									)}`,
							),
							', ',
						)}
            where ${where}
            returning *`
			: sql.query`
              select ${sql.join(select, ', ')}
              from ${sql.identifier(
								foreignTable.namespace.name,
								foreignTable.name,
							)}
              where ${where}`;

		console.log({ query });
		const { text, values } = sql.compile(query);
		const { rows } = await pgClient.query(text, values);
		return rows[0];
	};
};
const buildHook = build => {
	const { extend } = build;

	return extend(build, {
		pgNestedTableConnectorFields: {},
		pgNestedTableConnect: pgNestedTableConnect(build),
	});
};

const mapConstraint = (table, build) => {
	const {
		inflection,
		newWithHooks,
		describePgEntity,
		pgGetGqlInputTypeByTypeIdAndModifier: getGqlInputTypeByTypeIdAndModifier,
		graphql: { GraphQLNonNull, GraphQLInputObjectType },
	} = build;

	const tableFieldName = inflection.tableFieldName(table);

	return constraint => {
		const keys = constraint.keyAttributes;

		// istanbul ignore next
		if (!keys.every(_ => _)) {
			throw new Error(
				`Consistency error: could not find an attribute in the constraint when building nested connection type for ${describePgEntity(
					table,
				)}!`,
			);
		}

		const isIt = constraint.keyAttributes.some(pKey =>
			constraint.class.constraints
				.filter(con => con.type === 'f')
				.some(con => con.keyAttributes.some(attribute => attribute === pKey)),
		);
		if (isIt) {
			console.log({ constraint });
			return null;
		}

		return {
			constraint,
			keys: constraint.keyAttributes,
			isNodeIdConnector: false,
			fieldName: inflection.nestedConnectByKeyField({
				table,
				constraint,
			}),
			field: newWithHooks(
				GraphQLInputObjectType,
				{
					name: inflection.nestedConnectByKeyInputType({
						table,
						constraint,
					}),
					description: `The fields on \`${tableFieldName}\` to look up the row to connect.`,
					fields: () =>
						keys.reduce((res, k) => {
							res[inflection.column(k)] = {
								description: k.description,
								type: new GraphQLNonNull(
									getGqlInputTypeByTypeIdAndModifier(k.typeId, k.typeModifier),
								),
							};
							return res;
						}, {}),
				},
				{
					isNestedMutationInputType: true,
					isNestedMutationConnectInputType: true,
					pgInflection: table,
					pgFieldInflection: constraint,
				},
			),
		};
	};
};

const hookTable = build => {
	const { pgOmit: omit } = build;

	return table => {
		if (table.name === 'student_foreign_key') {
			// debugger;
		}

		return [
			table.id,
			table.constraints
				.filter(con => con.type === 'u' || con.type === 'p')
				.filter(con => !omit(con))
				.filter(con => !con.keyAttributes.some(key => omit(key, 'read')))
				// .filter(con => !con.keyAttributes.some(key => omit(key, 'connect'))) // HACK
				.map(mapConstraint(table, build))
				.filter(_ => _),
		];
	};
};

const toMap = (acc, [key, value]) => {
	acc[key] = value;
	return acc;
};

const filterPrimaryKeyConstraints = build => {
	const { nodeIdFieldName } = build;
	return table => {
		const { primaryKeyConstraint } = table;

		const isIt = primaryKeyConstraint.keyAttributes.some(pKey =>
			primaryKeyConstraint.class.constraints
				.filter(con => con.type === 'f')
				.some(con => con.keyAttributes.some(attribute => attribute === pKey)),
		);
		console.log({ isIt });
		return !isIt && nodeIdFieldName && primaryKeyConstraint;
	};
};

const handleTablePrimaryKey = build => {
	const {
		inflection,
		newWithHooks,
		nodeIdFieldName,
		graphql: { GraphQLNonNull, GraphQLInputObjectType, GraphQLID },
	} = build;
	return table => {
		const tableFieldName = inflection.tableFieldName(table);

		return [
			table.id,
			{
				constraint: null,
				keys: null,
				isNodeIdConnector: true,
				fieldName: inflection.nestedConnectByNodeIdField(),
				field: newWithHooks(
					GraphQLInputObjectType,
					{
						name: inflection.nestedConnectByNodeIdInputType({ table }),
						description:
							'The globally unique `ID` look up for the row to connect.',
						fields: {
							[nodeIdFieldName]: {
								description: `The globally unique \`ID\` which identifies a single \`${tableFieldName}\` to be connected.`,
								type: new GraphQLNonNull(GraphQLID),
							},
						},
					},
					{
						isNestedMutationInputType: true,
						isNestedMutationConnectInputType: true,
						isNestedMutationConnectByNodeIdType: true,
						pgInflection: table,
					},
				),
			},
		];
	};
};

const graphQLObjectTypeFieldsHook = (fields, build, context) => {
	const {
		pgIntrospectionResultsByKind: introspectionResultsByKind,
		pgNestedTableConnectorFields,
	} = build;
	const {
		scope: { isRootMutation },
	} = context;

	if (!isRootMutation) {
		return fields;
	}

	const tables = introspectionResultsByKind.class.filter(
		cls => cls.namespace && cls.isSelectable,
	);

	const write = require('./helpers');
	write('../tables.js', tables);

	tables
		.map(hookTable(build, context))
		.reduce(toMap, pgNestedTableConnectorFields); // FIXME side-effecting!

	// TODO check if the pk is identical to the fk?
	tables
		.filter(filterPrimaryKeyConstraints(build))
		.map(handleTablePrimaryKey(build))
		.forEach(([key, value]) => {
			// FIXME side-effecting
			build.pgNestedTableConnectorFields[key].push(value);
		});
	return fields;
};

module.exports = function PostGraphileNestedConnectorsPlugin(builder) {
	console.log('woot');
	builder.hook('inflection', inflectionHook);
	builder.hook('build', buildHook);
	builder.hook('GraphQLObjectType:fields', graphQLObjectTypeFieldsHook);
};
